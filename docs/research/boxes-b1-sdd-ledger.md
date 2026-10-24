# Boxes lot B1: SDD ledger (archived)

# SDD ledger — plan: docs/plans/2026-10-23-boxes-b1.md

Spec: docs/specs/2026-10-23-boxes-b1-design.md (programme: docs/specs/2026-10-23-boxes-design.md). Owner approved plan 2026-10-23 ("oui ca corresponds", "oublie pas le respect de DESIGN.md").
Worktrees: join /home/ubuntu/Workspace/soulkyu/pap-boxes-b1 (feat/boxes-b1); lanes created from S1's head: /home/ubuntu/Workspace/soulkyu/pap-boxes-b1-a (feat/boxes-b1-a), /home/ubuntu/Workspace/soulkyu/pap-boxes-b1-b (feat/boxes-b1-b).
Models: Sonnet implementers and task reviews; one Opus final review (J3). Briefs: brief.sh <ID>.

## Preflight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| S1 → all | BoxRef, boxKey, projectBoxPaths, BoxOp*, BoxOps, BoxControl, ProjectBoxSource | names match A5 createBoxOps, A6 createBoxControl, B1 createProjectBoxSource |
| S1 self | fake-boxes.ts has no consumer until lanes | knip would flag it → Ruling R1 |
| A1 self | vmd.ts change reaches runtime.ts call sites (A2's area) | A1 adapts runtime call sites minimally to compile; A2 does the rest |
| A3 ↔ A4 | profile enum `project` | moved into A3 (plan fixed before execution) |
| A4 ↔ A5 | git init argv | A4 plain `git init -b main`, A5 switches to shared argv (plan text) |
| A4/A5 ↔ B4 | isOkfIndex, knowledge ops | B4 uses fakes; consistent |
| A5 ↔ B4 | lanes module: A5 moves project-config parser to contracts, B4 adds a guard in lanes preview | different files; join merge note |
| A3 ↔ B4 | both edit sessions/service-launch.ts (knowledge for box rows) | Ruling R2 |
| A3 ↔ B2 | box rows carry projectId | B2 guarantees projectId on box rows; A3 keys vmLayoutOf on it |
| A6 ↔ B1 | dispose, rootOf | consistent |
| A7 ↔ B1 | addHost | consistent |
| A3 ↔ B1 | proxy reads box.hosts | consistent |
| B1 ↔ B2 | byPath → boxCwdOf | consistent |
| B5 ↔ A3 | mirror path `$PAP_HOME/boxes/.mirrors/<id>` | in Global Constraints for both |
| B1/B2/B6 | automation module edits (port, triggers.ts at cap, prechecks) | same lane, sequential; B2 moves code out of triggers.ts |
| B7 ↔ B1 | web needs box phase changes to reload panels; no push event planned | Ruling R3 |
| J1 | compose of all | — |

Ruling R1: S1 adds `apps/daemon/src/kernel/testing/fake-boxes.test.ts` exercising each fake (records calls, returns handler values) — keeps knip green before lanes consume them — cost if wrong: one small extra test file.
Ruling R2: the `service-launch.ts` change for box rows (no host `hasKnowledge`, knowledge path sent) belongs to A3 only; B4 does not touch `service-launch.ts` — one owner per file avoids a join conflict in a file near the cap — cost if wrong: B4's reviewer may flag the missing edit; point it here.
Ruling R3: B1 adds the box phase to the `shell` stream's project summary (`ProjectSummary.box?: {phase}` for box projects) and republishes the project on `BoxControl.onPhase`; B7 reloads Files/Changes/knowledge when its project's phase turns `running` — the plan's B7 "reloads on the running phase" needs a push path and the shell stream already carries project changes — cost if wrong: a small contract field to rename.

## Progress
S1: dispatched (BASE 0d1ae21b, implementer aa1fea3c44887c768)
S1: implemented e2e803e7 (DONE_WITH_CONCERNS: root tsc needed contracts dist in the worktree — env, fixed by `pnpm --filter @pap/contracts build`; BoxAuditActor defined in kernel/boxes.ts; files.ts exports result schemas; box_stopped EN/FR in web shell catalog)
Note: worktrees need `pnpm --filter @pap/contracts build` before `pnpm typecheck` (root tsc reads contracts' dist).
Task S1: minor (deferred): BoxAuditActor name (not AuditActor) and no "worker" actor — kernel/boxes.ts:30
Task S1: minor (deferred): fake byPath accepts `/boxes/p1/project/../x` (fake only; B1's real byPath must refuse) — fake-boxes.ts:241
Task S1: minor (deferred): Offset duplicated from files.ts; projectBoxPaths("/") gives //project; no 256-hosts pass test
Task S1: complete (commits 0d1ae21b..e2e803e7, review clean)
A1: dispatched (BASE e2e803e7, lane a, implementer a779b84bad5a97812)
B1: dispatched (BASE e2e803e7, lane b, implementer ac37ace76d9ccfdc7)
B1: implemented dadbbeca (DONE_WITH_CONCERNS: migration stamp 202610231300; lifecycle RPCs declare command_failed; kind optional on wire; removeProject async; sessions:admin now used → tokens grid shows it)
A1: implemented e1addb09 (DONE_WITH_CONCERNS: BoxVmSpec for the backend, VmSpec keeps agentId for A2; names pap_p_<32hex>, projects/<uuid>, trash project_<32hex>-<stamp>; lowercase uuid; observed-backend.ts; guest PAP_BOX/project layout left to A2/A4)
B1: review: spec ✅, quality needs fixes (I: deleting guard on lifecycle/setBox; I: duplicated isCleanPath/MAX_PROJECTS); 6 minors in task-B1-review.md (deferred)
Ruling R4: the canonical box project root is the project folder `/boxes/<id>/project` (= BoxControl.rootOf, projects.root, session cwd); byPath matches it and below; S1's fake and kernel/boxes.ts doc follow — plan Global Constraints say "project/ (cwd and pap's project root)" — cost if wrong: a path shape to change in B1/A3.
Ruling R5: `sessions:admin` becomes never-for-tokens (it now grants setBox hosts, rebuild, delete) like agents:admin — security: a token must not widen a box's egress — cost if wrong: a token cannot manage boxes (owner uses the browser anyway).
B1: fix round 1 dispatched (FIX_BASE dadbbeca): 2 I + R4 + R5 + R3 proof test + removeProject touches no file
Task A1: minor (deferred → folded into A2): ProjectId accepts uppercase uuids, pap-vmd only lowercase — box-name.ts:16, boxes.ts:11
Task A1: minor (deferred): 5 cosmetic/hardening minors in task-A1-review.md
Task A1: ⚠ kata int files edited, not run (J3 runs the kata project)
Task A1: complete (commits e2e803e7..e1addb09, review clean)
A2: dispatched (BASE e1addb09, lane a, implementer a9910e888b74c7030)
B1: fix round 1/5 (6 addressed, 0 open; commits dadbbeca..d0720c63)
Task B1: minor (deferred): no "project removed" shell event (other clients keep a deleted project until reload); other minors in task-B1-review.md
Task B1: complete (commits e2e803e7..d0720c63, review clean)
B2: dispatched (BASE d0720c63, lane b, implementer af778bea6a70b7c7a)
B2: implemented 65bb2b4d (DONE_WITH_CONCERNS: resolveFolder(cwd, ownerId) signature across automation; automation/index.ts at 400; trigger-folder.ts; precheck still host until B6)
Task B2: minor (deferred): no box tests for trigger update/runner preflight/dry-run/manual fire; duplicated `boxCwdOf()?.cwd ?? resolveSessionCwd()` in service.ts and automation-port.ts; `as never` Caller casts in box-cwd.test.ts; precheck still spawns on host for a box cwd (B6 removes prechecks)
Task B2: ⚠ resolved: service-launch.ts:150 `grants.scopeOf(row.cwd)` (host realpath + .git walk) must be skipped for a box row → carried into A3's dispatch (Ruling R2 owner)
Task B2: ⚠ deferred to J1: byPath should skip `deleting` boxes for new sessions (the launch gate refuses them anyway)
Task B2: complete (commits d0720c63..65bb2b4d, review clean)
B3: dispatched (BASE 65bb2b4d, lane b, implementer a0f4b48b608fbd852)
A2: implemented f0812000 (DONE_WITH_CONCERNS: box-ref.ts split to avoid an import cycle; logs field `box`; layoutOfSpec throws sandbox_unavailable for a project box until A3/A4; fail-closed stubs: relay policy (A3), proxy hosts (A3), guest layout (A4))
Carry: A3 must add the crash-pause Inbox for project boxes; A6 restartBox must call runtime.resume(box) after a crash pause; A7 egress refusal cards for project boxes (today log once).
Task A2: minor (deferred): crash pause of a project box only logged (carried to A3/A6); refused project box leaves no egress log line; project boxes report 0 turns (spurious relay mismatch warning possible); isHelloWithOtherProtocol checks only the envelope; thin allowed-side proxy test; log field agentId→box rename may break outside queries (doc it in J2)
Task A2: complete (commits e1addb09..f0812000, review clean)
A3: dispatched (BASE f0812000, lane a, implementer a3973abe768b53e75)
B3: implemented 8be9bf89 (DONE_WITH_CONCERNS: box_stopped relies on BoxOps itself (A5 answers it); box source bound without BoxOps → box_stopped; fs.search paths assumed root-relative)
B3: review: spec ✅, quality needs fixes (I: token list unfiltered box-backend.ts:131); 5 minors deferred; fix round 1 dispatched (FIX_BASE 8be9bf89): I + upload-http host-call proof + canonical guard
B3: fix round 1/5 (3 addressed, 0 open; commits 8be9bf89..5994fe69) — token list parity is "flag protected" like host list.ts (reviewer's "drops" was wrong)
Task B3: minor (deferred): no abort op on a failed mid-stream upload; download chunk sizes not checked against size; mtimeMs from the daemon clock and upload etag null; duplicated readOnly checks; no test for a guest search path starting with `/`
Task B3: complete (commits 65bb2b4d..5994fe69, review clean)
B4: dispatched (BASE 5994fe69, lane b, implementer a2b34cb48ffdf4874)
B4: implemented 6a26c2c8 (DONE_WITH_CONCERNS: J1 wiring of boxes/boxOps/boxControl into vcs + lanes config + ProjectBoxWiring.ops; knowledge decided by row kind; extra lanes guards forgeLine/approvedScript/approveScripts; knowledge methods async)
Carry to A5: git.blob from the daemon is `{path, side}` with path = oldPath ?? path for the `from` side (no oldPath sent); the guest reads `path` as given at `side`.
B4: review: spec ✅, quality approved; 5 minors deferred (boxRoots never pruned; mid-poll stop errors; viaGuest starting→box_stopped; untested approveScripts guard + token box snapshot; oldPath unused on git.blob); confirmed gap: other lanes entries reach host git for a box root → fix round 1 dispatched (FIX_BASE 6a26c2c8) + viaGuest deleting → not_found
Ruling R6: lanes entries keyed by laneId need no box guard — every lane row is created through create/fan-out/issue, which all call config.preview first, and preview refuses a box root (repo:false → not_found); a guard in store.getOwned would protect an unreachable path at the cost of ~8 module wirings — cost if wrong: a future lane-creation path that skips preview could reach host git for a box root (B3 lanes-in-box rework will touch this anyway)
A3: implemented e56bb8e8 (DONE_WITH_CONCERNS: box rows found via byPath(owner, cwd) (no projectId on SessionRow); crash-pause Inbox reuses agent_notify with the project id in agentId; ownerOverBudget added to automation agentTasks; no claudeEnv for project launches; budget block lags ≤60 s; taint int test at daemon root with a mini fake runtime)
B4: fix round 1/5 (2 addressed, 0 open; commits 6a26c2c8..e7bdfaf1)
J1 carry: wire `boxes` into createLanesConfigModule (compose-lanes.ts:107), vcs (boxes, boxOps, boxControl), files (boxes, boxOps), projects bindBoxes (control, ops), sessions/automation `boxes` source.
Task B4: complete (commits 5994fe69..e7bdfaf1, review clean)
B5: dispatched (BASE e7bdfaf1, lane b, implementer afb71afc016fcfb39)
A3: review: spec ❌ (I: no claudeEnv for project launches; I: crash-pause Inbox item anonymous agent_notify), quality needs fixes; 8 minors deferred (false agent_relay_mismatch for 0 turns; budget lag ≤60 s; crash pause not persisted; taint int test uses a fake runtime)
Ruling R7: the project box crash pause posts a new Inbox info kind `box_paused` (agentId null, triggerName = project name via a required `nameOf`, J1 binds it); B7 renders its row — agent_notify with a project id in agentId rendered as an unknown agent — cost if wrong: one Inbox kind to rename.
A3: fix round 1 dispatched (FIX_BASE e56bb8e8): claudeEnv for project launches + box_paused
J1 carry: boot ordering — confirm no box-root launch can happen before late `boxes` is bound (else a box cwd is treated as a host row); bind `nameOf`.
B7 carry: render Inbox kind `box_paused` (title EN/FR, the project name, a link to the project page).
B5: implemented 174a63b1 (DONE_WITH_CONCERNS: one scanner instance per root, reconcilePass scoped to its own root; no-row mirror file marked bad until it grows; real claim covered by unit test only)
B5: review: spec ✅, quality approved w/ 1 I (unknown mirror file → skip → bad forever; should wait); fix round 1 dispatched (FIX_BASE 174a63b1) + late-root test + resolve root once; other minors deferred (task-B5-review.md)
B5: fix round 1/5 (3 addressed, 0 open; commits 174a63b1..f134e51a)
Task B5: minor (deferred): a stray mirror file with no row stays waiting and is reprocessed every reconcile; root resolved per pass (not at construction); no late-root int test; see task-B5-review.md
Task B5: complete (commits e7bdfaf1..f134e51a, review clean)
B6: dispatched (BASE f134e51a, lane b, implementer afafa83d589409430)
A3: fix round 1/5 (2 addressed, 0 open; commits e56bb8e8..ef578aee)
Task A3: minor (deferred): null agentId accepted for any kind (type-level guard only); budget lag; crash pause in memory
J1 carry: remove a project's `box_paused` Inbox rows when the project is deleted (refId/triggerName match, not agentId).
Task A3: complete (commits f0812000..ef578aee, review clean)
A4: dispatched (BASE ef578aee, lane a, implementer a6a220716ee0eeaf3)
A4: implemented 1ff38fd3 (DONE w/ concerns: isOkfIndex keeps the daemon's exact rule (no frontmatter requirement); message-mix not extended to profile project; no Dockerfile change)
A4: review: spec ✅, quality needs fixes (I: message-mix excludes project); fix round 1 dispatched (FIX_BASE 1ff38fd3) + project without vm fails closed + 2 doc/test titles; deferred minors: policy.md not updated (J2), cloned repo with an OKF index turns the section on (intended: OKF is per project), missing read-only-command test
A4: fix round 1/5 (3 addressed, 0 open; commits 1ff38fd3..564b6b54)
Task A4: complete (commits ef578aee..564b6b54, review clean)
A5: dispatched (BASE 564b6b54, lane a, implementer a648f98e154a01ea7)
B6: implemented 59fc5dfc (DONE_WITH_CONCERNS: precheck_removed refused before pause/budget gates; no int test through a real daemon; spawn-counter helper deleted; tracer span kind/journal verdict strings kept for old rows)
Task B6: minor (deferred): webhook / task retry still fire a trigger with a stored precheck (nothing spawns; webhooks always ignored prechecks); precheck_removed journaled before paused/budget; no-op onChange on the disabled field; no comment on {{precheck}} rendering empty
Task B6: complete (commits f134e51a..59fc5dfc, review clean)
B7: dispatched (BASE 59fc5dfc, lane b, implementer a5039b337a36f61f1)
A5: implemented fa3d2f15 (DONE_WITH_CONCERNS: .git listed (protected) per plan text; readProjectConfig gains optional packages/badPackages; guest failed → worker_failed, bad result → worker_failed, abort → timeout; fs.put skip answers done+skipped on chunk 1; yaml dep moved to contracts (web dist clean); small duplications)
Ruling R8: box Files hide `.git` like the host Files tree (spec §6: "the protected-path rules of the host Files module apply the same way" beats the plan's "`.git/` is listed") — cost if wrong: one line in guest/ops/fs-list.ts.
A5: review: spec ❌ (I: fs.write/fs.put can write the .git entry itself), quality needs fixes; 7 minors deferred; fix round 1 dispatched (FIX_BASE fa3d2f15): .git component refusal + R8 hide .git + safe.directory=<project> + oversized op result → payload_too_large
B7: implemented c544d7e5 (DONE_WITH_CONCERNS: BoxPausedRow finds the project by refId then unique name; extra copy written in i18n/catalog/boxes.ts; Files stopped panel in the explorer column; features/boxes domain + one eslint allow rule; AgentResources → boxes/ResourceFields; web.md/sessions.md not updated (J2))
Ruling R9: a `box_paused` item's refId is the project id (one item per project, dedupe by (refId, kind), removable on delete; B7's row looks up by refId) — J1 changes A3's poster from a random ref — cost if wrong: repeated pauses of one project collapse into one item (intended).
A5: fix round 1/5 (4 addressed, 0 open; commits fa3d2f15..3bd7bdf3)
Task A5: minor (deferred): guest failed/bad result → worker_failed (undeclared on files/vcs methods → internal at the RPC edge); small duplications (cutText, excluded names, temp-name regex); see task-A5-review.md
J1 carry: wire createBoxOps; B3's upload consumer must stop at the first `{done:true, skipped:true}` answer (A5 answers skip on chunk 1).
Task A5: complete (commits 564b6b54..3bd7bdf3, review clean)
A6: dispatched (BASE 3bd7bdf3, lane a, implementer a888f68a55a586e31)
B7: review: spec ❌ (I: MB/CPU not tabular; I: knowledge row stopped state not EmptyState), quality needs fixes; fix round 1 dispatched (FIX_BASE c544d7e5): tabular TextField option, R10, no concatenation, polite live region once, Scratch-only conflict copy, extract hosts editor, three-part errors, shared CANCEL/CLOSE keys
Ruling R10: the knowledge row stays an inline fact line (muted sentence + START) when the box is stopped; only Files and Changes panels use EmptyState — DESIGN.md §9.1 EmptyState is a panel pattern, a dashed frame inside one fact row would break the facts layout — cost if wrong: one component swap.
Task B7: minor (deferred): duplicated hidden-character regex; BoxStopped shows no action when no project is found
B7: fix round 1 done ae45e2b6 (8 items); fix round 2 dispatched before the re-review: startBox/restartBox declare capacity/vm_bundle_stale/agent_paused/sandbox_unavailable + three-part texts (spec §3) — one re-review will cover c544d7e5..round-2 head
B7: fix rounds 1-2/5 (9 addressed, 0 open; commits c544d7e5..c479ff8b)
Task B7: minor (deferred): two polite announcements on a stream-reported `starting` (chip + BoxStart line); hosts textarea 4→3 rows; forbidden/step_up_required/box_stopped keep house texts (three-part not checked)
Task B7: complete (commits 59fc5dfc..c479ff8b, review clean)
Lane B: complete (e2e803e7..c479ff8b)
A6: implemented a8a9c5ff (DONE_WITH_CONCERNS: runtime.ts +start(spec)/touch/onPhase (381 lines); box-ops touches the idle wait; kata-backend reports project images started/stopped; trash sweeps boxes/.trash; built/wanted persisted in $PAP_HOME/vm/project-images.json)
J1 carry (A6): pass `gate` = guardedLaunch's checks (stack, relay ready, bundle skew); composeBoxes `images.resolve` → projectImages.tagOf(id); route KataImages.notice(projectId) to that project's live sessions; BUILD_NOTICE says "cet agent" (project wording needed).
A6: review: spec ❌ (I: built set before the background build completes; I: every op re-arms idle (vcs poll keeps a box alive); I: dispose not serialized with restart/launch), quality needs fixes; 6 minors deferred; fix round 1 dispatched (FIX_BASE a8a9c5ff)
Ruling R11: `BoxOps.poll(projectId, op, signal?)` = `call` without the idle reset and without starting anything; the vcs poller uses it (J1 switches it) — spec: subscriptions and polls never keep a box alive — cost if wrong: one method to rename.
A6: fix round 1/5 (3 addressed, 0 open; commits a8a9c5ff..a54572bd)
Task A6: minor (deferred): after purge reopens the key, an in-flight spawn for that project id could start a fresh disk (narrow window; the project gate refuses a missing row at launch); 6 minors in task-A6-review.md
J1 carry (A6): switch the vcs poller to BoxOps.poll; pass the notice router to createProjectImages; projects.rebuild must catch control.rebuild's throw (failed build → command_failed).
Task A6: complete (commits 3bd7bdf3..a54572bd, review clean)
A7: dispatched (BASE a54572bd, lane a, implementer a51cf8ba78a26f46d)
A7: implemented 9908e365 (DONE_WITH_CONCERNS: callers agent-thread/plain/task/child, non-box non-thread rows forbidden; project-host.ts (entry check, 256 cap → limit_reached, hashed log); project card wording "from now on, in every session of the project")
J1 carry (A7): align lane B's real addHost (projects/box-source.ts) to audit reason `project_host_added`, detail `{projectId}` only (no raw host), and refuse (not silently drop) a full list.
Task A7: minor (deferred): unattended-task test doesn't drive the question/timeout path; a host already on the list still gets a fresh card in another session; project-host.ts doesn't check deleting; a full list gives no card feedback (log only)
Task A7: complete (commits a54572bd..9908e365, review clean)
Lane A: complete (e2e803e7..9908e365)
J1: merging lanes into feat/boxes-b1
J1: lanes merged at 182717c0 (no conflicts, typecheck green); J1 dispatched (BASE 182717c0, join worktree) (implementer ad999c539c15de78a)
J1: implemented f9efa781 (DONE_WITH_CONCERNS: wiring in compose-boxes-wiring.ts; daemon-types.ts + compose-agents-vm-seams.ts split out; 6 journeys green on the real guest; 7 lane bugs fixed in place (process-backend layout, Pi file binding, search mirror parents created at boot, vcs box diff judged by host boundary, delete order tasks→sessions→box, guardedLaunch skew check for projects, terminal given box roots); box notice FR only; box_paused not resolved on restart; skipped upload keep-alive hang-up like host)
J2: dispatched in docs worktree /home/ubuntu/Workspace/soulkyu/pap-boxes-b1-docs (feat/boxes-b1-docs from f9efa781), in parallel with J1's review
Task J1: minor (deferred → final review triage): no journey for Review Focus 3 (look-alike cwd; unit only) and Focus 2 partial in journeys (Files only); Focus 4 journey does not assert the owner's list untouched nor a host session's network.request refusal; search mirror-folder creation untested for 0700/idempotence and reaches into the agent-vm layout; C6 test greps daemon.ts source; box-status.ts token judge of `/${path}` may refuse a file under a hidden-named first segment; daemon.ts +25 wiring lines (needed for C6); box notices FR only (brief says EN/FR); host spy misses fs.promises/statSync/readdirSync; C9 skip test asserts only the answer; box_paused not resolved on restart
Task J1: ⚠ Kata-only wiring (boxStack.client, backend kata, images.resolve over KataImages, stale-bundle check for a project box) and disk-to-trash on delete: J3 kata journey
Task J1: complete (commits 182717c0..f9efa781, review clean)
J2: implemented 2e0d418b (docs only; doc tests green); merged into feat/boxes-b1. Task J2: complete
J3: final Opus review dispatched (MERGE_BASE 0d1ae21b, HEAD dd0fc4c2)
J3: final review: ready after fixes — 0 C, 6 I (launch taint only from proxy; Fork/Duplicate of box sessions reach the host; host Pi helpers (MCP/Skills/trust/subagent profiles) get box roots; no project removal event; settings hides the wanted package list; wrong hosts hint copy) + minors to fix (relay mismatch spam, webhook/retry with stored precheck, token hidden top-level dev/run/proc/sys in boxes, docs over-claims); Kata unverified (root window)
J3: final fix wave dispatched (FIX_BASE dd0fc4c2)
J3: final fix wave done (dd0fc4c2..73733a84: I1–I6, M1–M3, D1 with tests); note: a broad agent-vm directory run also started six *.kata.int files, which stopped at their guard (pap-vmd set up for ~/.pap, not ~/.pap-kata) after reading the real pap-vmd config read-only — nothing emptied or started; fork refusal: box rows sandbox_unavailable, agent rows keep bad_request
J3 root window: final gate green (lint, format, typecheck, knip, build); preview stopped; DB backed up ~/.pap/backups/manual-pre-boxes-b1-2026-10-24T03-53-03-084Z.db; vm setup --home ~/.pap-kata --dev-from-tree done; kata project running
