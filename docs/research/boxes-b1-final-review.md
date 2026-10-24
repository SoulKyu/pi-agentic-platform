# Boxes lot B1: final review (archived)

# Final review: boxes lot B1 (feat/boxes-b1, 0d1ae21b..dd0fc4c2)

Reviewer: J3 (Opus), read-only, one reviewer, no subagents. I reviewed in passes:
1. the wiring (`daemon.ts`, `compose-boxes*.ts`, `compose-workspace.ts`, `compose-agents-vm*.ts`);
2. every consumer of a session cwd or a project root, followed by hand (files, vcs, sessions, automation, lanes, terminal, policy, trust/mcp/skills/subagents, forks, export, search, knowledge);
3. pap-vmd, the gateway, tokens, relay, proxy, the guest ops and the pi-host `project` profile;
4. the web against DESIGN.md;
5. the ledger's deferred items.

I ran no test suite and no Kata test (see "Not verified").

## Strengths

- **One routing rule.** `kernel/box-path.ts` `boxOfPath` and `projects/box-source.ts` `byPath` are lexical, owner-scoped and refuse look-alikes. Each consumer asks the box source before any host backend:
  - Files: `files/service.ts:76-103`.
  - vcs: `vcs/service.ts` `authorize`.
  - Sessions: `newBoxCwdOf` in `sessions.create` and `createTaskSession`.
  - Triggers: `folderOf` and `projectOf`.
  - Project link: `project-link.ts:181`.
  - Terminal: `hostRoots`.
  - Lanes: preview.
  The ordering argument in `compose-boxes-wiring.ts` holds in `daemon.ts`: the source is bound before any path-reading module is built.
- **pap-vmd's surface stays closed.**
  - `BoxRef` is strict, with lowercase UUIDs only.
  - Project names (`pap_p_<hex>`, `projects/<uuid>`, `project_<hex>-<stamp>`) can never parse as an agent's.
  - A project box with a task key is refused at the schema (`contracts/vmd.ts` `agentTasksOnly`).
  - `PAP_BOX` passes `ENV_VALUE`.
- **Guest operations are careful.**
  - Paths: a nofollow descriptor chain, `segmentsOf` refuses `..`, empty and NUL segments, and `.git` is refused for writes at any depth.
  - git: the shared neutralised argv plus the guest's own filter scan, `GIT_CONFIG_GLOBAL=/dev/null`, `safe.directory` set exactly. `rg` runs with a fixed argv and no query.
  - Results: every result is schema-checked on the daemon side, with bounded frames, 8 in flight and a timeout.
  - `poll` versus `call` keeps the vcs timer from holding a box alive.
- **Delete.** The order is mark `deleting`, cancel tasks, stop sessions, dispose, rows, and it is retry-safe. The journey proves it with a real guest and worker: a running task ends `cancelled`, the mirrors are trashed and `box_paused` is removed.
- **Tokens.**
  - `sessions:admin` can no longer be granted to a token, and stored grants are filtered at authentication (`auth/tokens.ts:143`).
  - "Allow this host" is browser-only (`mayGrantHost`), and the host goes to exactly the row's project (`project-host.ts`, `box-source.ts` `addHost`).
- **Agents.** Agent behaviour is unchanged on every path I followed: crash log, pause, phase, status, delivery, mirrors, refusal cards, relay policy. The protocol bump and the `agentId` to `box` log rename are documented in ADR 0083 and `agents-vm.md`.
- **Web.**
  - Tokens and primitives only. The one primitive change is a `numeric` prop on `TextField` (tabular figures).
  - Variants follow the plan: START is `primary`, DELETE is `danger` and its Cancel is not.
  - A stopped box is `mut`, every chip carries a word, and the stopped Files and Changes panels use `EmptyState`.
  - §7.3 timing through `pendingSince` and `useStartFeedback`, a polite live region on the phase chip, and errors in the three-part pattern in EN and FR.

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix before merge)

**1. A tainted box session does not taint its launch; only the proxy's taint does.**
- Where:
  - `apps/daemon/src/modules/agent-vm/launch-taint.ts:25` (`mark` is called only by the proxy, `compose-agents-vm-proxy.ts:92`).
  - `apps/daemon/src/modules/sessions/policy-link.ts:183-189`, where a worker's `TaintFact` is stored for that session only.
  - `apps/daemon/src/modules/automation/runner.ts:221`, where a webhook or feed task starts `tainted: true`.
  - `compose-agents-vm-proxy.ts:98`, where `join` taints a joiner of a marked launch, but a tainted joiner never marks the launch.
- What happens: all of a project's sessions and tasks share one VM launch (`vm-launch.ts:115-118`). A webhook task with an untrusted payload can write `project/AGENTS.md` or plant files. The owner's next interactive session in the same launch then runs untainted: exfiltration-capable actions are not asked again, and the `network_request` card does not say "read outside content".
- Why it matters:
  - Spec §4 is binding: "When one session of a launch is tainted, every session of that launch is tainted, including trigger tasks".
  - The programme spec calls taint per session inside one box "an illusion on a shared disk".
  - `docs/agents/agents-vm.md` ("Project boxes", "Known limits") now claims this guarantee.
- Fix:
  - When a box row's taint is raised (the policy module's `onSessionChange` with taint, or `markTainted` for a row where `boxes.projectOf(row) !== null`), mark that row's launch and taint every session of it.
  - A session that joins already tainted (a task created with `tainted`) marks the launch too.
  - This needs a session-to-launch map. `joinLaunch` already records every pair.
  - Add one int test: a tainted task, then a fresh session in the same launch, starts tainted.

**2. Fork and Duplicate of a box session run Pi's SDK on the host over the VM-written mirror, then fail `internal`.**
- Where:
  - `apps/daemon/src/modules/sessions/service.ts:167` `notAgent` refuses agent rows only. This is an ADR 0081 agents-only predicate.
  - `forks.ts:131/151` then calls `writer.fork(row.piPath)`. The source is `$PAP_HOME/boxes/.mirrors/<id>/<file>`, and `pi-writer.ts:199` `SessionManager.open(path, dirname(sourceFile))` writes the new file into the box's mirror folder.
  - `adopt` refuses it (`forks.ts:98`, `fork_file_refused`) and the call answers `internal`.
  - The web offers both actions on every box session: `features/sessions/RowActions.tsx:70` (Fork) and `features/sessions/SessionActions.tsx:124` (Duplicate).
- Why it matters:
  - Two visible actions are broken on every box session.
  - The host's Pi SDK parses a file the box wrote, which the host otherwise reads only through pap's own bounded mirror parser.
  - A transient file appears in a mirror folder that search watches.
- Fix:
  - Refuse every VM row before `loadWriter`: `agent.vmLayoutOf(row) !== null` answers `sandbox_unavailable`, like `exportHtml`.
  - Disable both actions for a box session, with the reason as muted text (DESIGN §9.1).

**3. Box roots reach the host's Pi configuration helpers (MCP, skills, plugins, trust, subagent profiles).**
- Where:
  - `apps/daemon/src/modules/projects/service.ts:252` `covers` accepts a box root. As a result, `mcp/service.ts:89/103`, `skills/service.ts:66` and `trust/service.ts:88` hand `/boxes/<id>/project` to a host helper as its `cwd`.
  - `subagents/profile.ts:17` and `profiles.ts:36` run `trust.status(cwd)` for every row that is not an agent's. `isAgentSession` is the agents-only predicate here, so box rows go through it.
  - The web sends box roots in four places: Settings › MCP and Skills (`routes/settings/McpSettings.tsx:20`, `features/skills/use-skills-data.ts:33`), `DryRunPanel` (`trust.status {cwd}`), and the session `TrustBanner` (`SessionScreen.tsx:192`).
  - About the banner: pi-host still reports `projectTrust.required` for a box repo that has `.pi/` resources (`open-session.ts:283`), so the banner offers "trust this folder".
- What happens on Kata (the folder does not exist on the host):
  - The trust helpers answer `bad_params`.
  - The MCP and Skills project sections are empty but editable; an "add project server" fails.
  - Trust (with the step-up) records `/boxes/<id>/project` in the host's `trust.json`, which pi-web shares, and it can never take effect in the box.
- What happens on the process backend: the host helper reads `<root>/.pi/*`, and MCP Test could start a box project's server on the host.
- None of this is covered by `boxes.host-reads.int.test.ts`: the helpers are child processes and the spy only sees the daemon's own helpers.
- Why it matters:
  - It breaks the spec §3 rule "the daemon routes any path under a box project's root to that box, and never to the host file system".
  - It is misleading UI on a path the journeys do not cover. Spec §4 says a box repo's `.pi/` resources do not load in B1.
- Fix:
  - Daemon: a box root is never a helper `cwd`. Either `covers` gets a host-only variant for these services, or they answer `invalid_cwd` or drop to global-only for a box root. The subagent check should use "runs in a VM" instead of `isAgentSession`.
  - pi-host: report no `projectTrust` for a project box, as for agents.
  - Web: send no `cwd` for a `kind: "box"` project, and add one muted line saying a box repo's own `.pi/` resources do not load yet.

**4. A deleted project stays in the deleting client's switcher and sidebar, with its sessions, until a reload.**
- Where:
  - `packages/contracts/src/shell.ts:136`: the shell stream has a `project` upsert and no removal.
  - `box-service.ts` `remove` publishes nothing.
  - `project-port.ts:44` only sends `countsChanged`.
  - `features/projects/ProjectSettings.tsx:195`: `onDeleted` only closes the dialog.
- Why it matters:
  - The ledger deferred this as "other clients", but the client that deleted is affected too.
  - The current project can stay on the deleted one, and every later click answers `not_found`. A reasonable user expects a deleted project to disappear.
- Fix: a `projectRemoved {projectId}` shell event published by `remove()`. The store drops the project and its sessions and resets the current project if it pointed there. At minimum, the deleting client drops it locally and navigates home.

**5. The "wanted" packages are never shown.**
- Where: `features/projects/ProjectSettings.tsx:153-169` shows `built`, the notice and REBUILD, but nowhere renders `box.packages.wanted`.
- Why it matters: spec §3 says "the project page shows both lists and a **Rebuild** button". The wanted list is written by the agent (`.pi/project.yaml`), and the owner approves a rebuild without seeing what it installs.
- Fix: render the wanted list beside the built one (EN/FR), and keep the notice and chip as they are.

**6. The hosts hint says the opposite of the model.**
- Where:
  - `apps/web/src/i18n/catalog/boxes.ts:26` "Added to your own list." and `:96` "Ajoutés à votre propre liste.".
  - The doc comment at `ProjectSettings.tsx:35`.
- Why it matters:
  - The list is the project's own; the box reaches the owner's list *plus* it (spec §7, a union that never touches the owner's list).
  - Copy in an egress editor must state exactly what a host reaches (AGENTS.md: copy never claims more; DESIGN §11).
- Fix: "This project's box can reach these hosts, on top of your own list (Settings › Policy)." and its FR equivalent.

### Minor (new in this review)

1. `apps/daemon/src/modules/agent-vm/vm-init.ts:49`: a box worker always starts in `project/`.
   - A session or trigger created at `<root>/sub` runs at `<root>`, while the row and the UI show `sub`.
   - Either pass the row's cwd (it is already judged lexically under the root) or refuse sub-folders for box rows.
2. Spec §3 "Purge now" for a deleted project is missing. `BoxControl.purge` exists, but no RPC or UI reaches it.
   - The plan omitted it; this is a plan gap, not an implementation slip.
   - The 7-day sweep still empties the trash.
3. `projects.create` succeeds on a host without KVM or without `pap vm setup`; ADR 0083 says it cannot. The project exists but cannot start (`sandbox_unavailable`). Consider calling `vmStatus.require()` at create, or showing the stack's state in the dialog.
4. `policy.listRules {cwd}` (`features/sessions/AlwaysRules.tsx:79`) for a box session runs host file calls on the box path.
   - It goes through `projectScopeOf` (`policy/project-scope.ts:35`: `realpathSync`, then a `statSync` walk for `.git`) and `lanes.paths.laneOf` (`realish`).
   - This is harmless on Kata, where the path is absent, but it is a host call with a box path, and the host spy does not record `statSync`.
   - A box root should be its own scope.
5. `projects.delete`, `startBox`, `restartBox` and `rebuild` declare no `internal`, though `wired()` and dispose failures throw it. They map to `internal` at the edge anyway.
6. `byPath` runs one query over all the owner's box projects per call, and `hostRoots` (`compose-workspace.ts:180`) repeats it per root. This is fine at today's scale.
7. The project settings are a `Dialog`, while the plan said "follow the existing settings panels". B7 accepted this; confirm with the owner.

## Deferred minors from the ledger: triage

**Fix before merge (cheap, and each one has an effect in production):**
- **A2.3 / A3.1.** `relay-link.ts:175` warns `agent_relay_mismatch` for every busy project box, because `reportedTurns` is 0 for project boxes (`compose-agents-vm-relay.ts:83`). Production would get warn-level noise and a misleading integrity signal. Skip the check for `box.kind === "project"`.
- **B6.** A webhook fire of a trigger that holds a stored precheck still runs its task. Spec §5 says it is "refused at fire". Add `refuseStoredPrecheck` to the webhook path, and to task retry if it re-fires.
- **J1.5 (and Files, same rule).** Under `NO_HOST_BOUNDARY`, `/${rel}` makes a box's top-level `dev/`, `run/`, `proc/` or `sys/` folder `token_hidden`. Locations: `files/box-backend.ts:74-79`, `vcs/box-status.ts:81`. A token cannot read `project/dev/...`, and `dev/` is a common repo folder. Judge the relative name under a neutral prefix.
- **B1 "no project removed event"**: moved up to Important 4.
- **Docs, together with Important 1 and 3.** In `docs/agents/agents-vm.md`, the "Project boxes" and "Known limits" sections claim that a tainted session taints the whole launch and that "the host never reads or runs a box project's content". Make them true or state the limit.

**Keep deferred** (cosmetic, test-only, or accepted residual): S1 (all), A1 (cosmetic, plus the kata note below), A2.1/2/4/5/7, A3.2/3/4/7/8, A4 (all), A5 (all), A6 (all), A7 (all), B2 (test gaps; the duplicated `boxCwdOf()?.cwd ?? resolveSessionCwd()`), B3 (all), B4 (all), B5 (all), B6 (other three), B7 (all), J1.1/2/3/4/6/7/8/9.

**⚠ Kata (A1, J1):** this is the one deferred item that blocks merge, and it is not code. The Kata journey and the Kata-only wiring must be run in the root window before the branch reaches main or the preview (see "Not verified").

## Recommendations

- Grep for every remaining `agentId !== undefined` / `isAgentSession` / `notAgent` that stands for "runs in a VM", and switch each to the shared VM predicate (`vmLayoutOf(row) !== null`). Important 2 and the subagent half of Important 3 come from this pattern.
- Widen the host spy to `statSync`, `readdirSync`, `fs.promises.*` and the Pi helper's `cwd`. Add one journey that opens Settings › MCP and Skills and forks a session with a box project current.
- Rehearse the merge procedure with the owner. The update stops every live agent until `sudo pap vm setup` runs (protocol 2), and that is a root change.

## Declined to judge

- Terminal, GitHub and lanes inside a box: off by spec (B2, B3). I only checked that they are refused.
- Host projects, the host scanner and pi-web coexistence (B4).
- Box disk backups (sub-project 4).
- A repo's own `.pi/` resources not loading in a box: a documented limit (spec §4). Only the UI that pretends otherwise is flagged (Important 3).
- Daemon notices and Inbox details in French only: the house pattern shared with agents. This is the owner's call.
- Proxy refusals for a project box are only logged (`egress_refusal_no_thread`), with no card or Inbox item. Spec §7 is silent, and `network_request` is the ask path.
- The 60 s budget-block lag for boxes (A3.2): the spec does not set a latency.
- Performance of `byPath` beyond the note in Minor 6.

## Not verified

- **The Kata project-box journeys** (`modules/agent-vm/project-box.kata.int.test.ts`, `apps/vmd/src/vmd.kata.int.test.ts`) and all the Kata-only wiring:
  - `boxStack.client` disk to trash and purge;
  - `KataImages.resolve` keyed by a project id, including the first build and the build key;
  - the stale-bundle check for a project box;
  - the `/boxes/<id>` mount and the guest's `grow`;
  - pap-vmd's `projects/` folders and net restore of `pap_p_` names;
  - `safe.directory` under a real uid split.

  These need `sudo pap vm setup` from this branch on this host, which stops the live preview's agents (protocol 2). That is a root change for the owner to approve, so I did not run them.
- No unit, int or e2e suite, `typecheck`, `lint` or `knip` run in this review. I relied on the per-task gates and J1's report.
- No visual check of the web (headless host). The DESIGN.md judgement is from the code.

## Assessment

**Ready to merge?** With fixes.

**Reasoning:** The VM stack, the routing rule, the guest operations and the token rules are sound, and agents are unchanged. No finding is a direct host compromise on Kata, because a box's files never exist on the host there. Six Important items cross task boundaries:
- Launch taint is proxy-only, against the binding spec, and the docs claim more.
- Two agents-only predicates still apply to box sessions: Fork and Duplicate, and the Pi helpers with box cwds.
- A deleted project stays in the UI.
- The wanted packages are not shown.
- The hosts hint has the wrong meaning.

All are small. The three cheap deferred minors and the Kata root window should be done before the merge.

## Fix wave re-review

# Final fix wave re-review (dd0fc4c2..73733a84)

I1 ADDRESSED - launch-taint.ts join(tainted)/raised(); compose-agents-vm-late.ts:179 hooks policy.onSessionChange (box session, no agentId) -> launchRaised -> proxy.raised; vm-launch.ts passes {ownerId} for project boxes only, compose-agents-vm.ts probes taintedNow; setTaskPolicy and markTainted both notify (policy/session-service.ts), so both orders are covered; agents skipped; new launch clean (ended() clears). Tests cover each.
I2 ADDRESSED - sessions/service.ts notInVm: agent row bad_request, other VM row sandbox_unavailable, before forks/writer; RowActions inBox hides Fork, SessionActions omits Duplicate.
I3 ADDRESSED - projects/service.ts coversHost (every covering root must be host); lane-covers.ts withLaneRoots uses it and compose-pi.ts:59 hands that port to models, mcp, trust, skills; subagents use runsInVm (no isAgentSession left); web MCP/Skills send no cwd for a box and show boxes.off; TrustBanner gets null in a box.
I4 ADDRESSED - box-service.remove -> removed -> projects onRemoved -> sessions/service.ts publishes projectRemoved; contracts event; reducer drops project and its sessions; ProjectSettings onDeleted closes and navigates "/".
I5 ADDRESSED - PackageList shows built list and, when packagesChanged, the wanted list before Rebuild.
I6 ADDRESSED - boxes.hosts.hint EN/FR reworded (project's list, on top of the owner's, vous).
M1 ADDRESSED - relay-link.ts skips mismatch for usage.box.kind === "project", usage line still logged.
M2 ADDRESSED - hooks-http 409 precheck_removed before fire; createRetry conflict; both journaled via refuseStoredPrecheck, nothing spawns.
M3 ADDRESSED - judgeBoxName judges under neutral /project prefix; used by Files (read/search) and vcs diff; .mcp.json / .pi names still hidden.
D1 ADDRESSED - agents-vm.md, automation.md, sessions.md match the code (taint rule, global-only MCP/Skills, fork/duplicate, projectRemoved, both lists, hosts wording).

New breakage: none Critical/Important. Agents path unchanged (hook skips agentId rows, notInVm keeps bad_request, join param only for project boxes). Host projects unchanged (coversHost == covers without box rows). Web pieces use existing tokens.
Out-of-scope: none.
Tests: report names covering tests/outputs; not re-run.
