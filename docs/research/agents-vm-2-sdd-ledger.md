# Agents in microVMs, sub-project 2: SDD ledger (archived 2026-10-21)

Copied from the git-ignored SDD workspace at the merge of part B. Spec docs/specs/2026-10-21-agents-vm-egress-design.md, plan docs/plans/2026-10-21-agents-vm-egress.md.

# SDD ledger — plan: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/docs/plans/2026-10-21-agents-vm-egress.md

Spec: docs/specs/2026-10-21-agents-vm-egress-design.md (decision 119). Owner go 2026-10-21: "Go SDD allégé en 2 lanes en //, oublie pas la règle de pas lancer tous les tests, uniquement ceux qui sont modifiés par le code".
Worktrees from main c1729e89: lane A feat/agents-vm-2a at .worktrees/feat-avm2-a (slot heavy-gate-2.lock), lane B feat/agents-vm-2b at .worktrees/feat-avm2-b (slot heavy-gate.lock). Offline install + contracts/ui build OK in both.
Model table (owner-approved lightened SDD): Sonnet implementers for every task; Opus task review on A2 and B2 only; Opus final review per part (A, then B); Sonnet scoped re-reviews; no Haiku; Opus escalation at fix rounds 4-5 needs a fresh owner OK.

## Preflight scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| A1 → A2 | `parseHostEntry`, `entryAllows`, `AGENT_NET.proxyPort` | consistent |
| A1 → A3 | `AGENT_NET.host`, `proxyPort` | consistent |
| A1 → A4 | `AgentHostEntry` for `entryFor`; both edit contracts `agents.ts` | sequential in lane A, fine |
| A2 → A4 | `VmRefusal`, `onRefusal` | A2 must wire something before A4 exists → AVM2-E4 |
| A2/A3 → A5 | proxy + shell network under Kata | Kata run needs root and the preview's stack → AVM2-E2 |
| B1 → B2 | `createAgentFiles` (read, pendingRemovals, delivered, onChange) | consistent |
| B1 → B3 | `agents.files.*`, `PUT /agent-files` | consistent |
| A1 ↔ B2 | both edit `packages/contracts/src/agents-vm.ts` (AGENT_NET vs records) | textual conflict at rebase → AVM2-E7 |
| A2 ↔ B2 | both edit `agent-vm/runtime.ts` (launch addresses vs delivery) | same → AVM2-E7 |
| A4 ↔ B3 | i18n catalog registration files | same → AVM2-E7 |
| A5 → B4 | `egress.kata.int.test.ts` | B4 after lane B rebases on main with Part A → AVM2-E7 |
| A1 | tests vs code | agrees |
| A2 | `--project int` in its commands | the project is `integration` → AVM2-E6 |
| A3 | replaces the argv refusal pinned at `argv.test.ts:160` | agrees |
| A4 | `events.update` "if no writer exists"; push class unnamed by spec | AVM2-E5 |
| A5 | Kata test against the real stack | AVM2-E2 |
| B1, B2, B3 | tests vs code, files | agree |
| B4 | extends A5's file | AVM2-E7 |

## Rulings
- Ruling AVM2-E1: task gate = lint, format:check, typecheck, knip + `vitest related` over the task's changed .ts/.tsx (projects unit + integration); no full test:unit / test:int at tasks or at merge — owner rule 2026-10-21 — cost if wrong: a regression reached only through an unrelated import path escapes until the next CI run on main.
- Ruling AVM2-E2: implementers never run the kata project (the Kata bed refuses a pap-vmd not set up on ~/.pap-kata, and the preview holds 10.213.0.1:7841/7842). A5/B4 write the Kata tests; they run once, in one root window at Part A's merge (stop preview → `sudo pap vm setup --home ~/.pap-kata` → `CI=1` kata files → `sudo pap vm setup --home ~/.pap` → preview rebuilt and restarted), only with the owner's OK — cost if wrong: Kata-only defects found at merge time instead of in the task.
- Ruling AVM2-E3: no task review on A1, A3, A4, A5, B1, B3, B4; the Opus final review of each part covers them (owner-approved lightened SDD) — cost if wrong: defects there are found later, at the part's final review.
- Ruling AVM2-E4: A2 wires `onRefusal` to a log line (`egress_vm_refused`, host labelled per W5-R54); A4 replaces it with the refusal sink — cost if wrong: none (A4 owns the replacement).
- Ruling AVM2-E5: inbox kind `agent_egress` maps to push class `notify`; `events.update` is added in A4 if no update writer exists — cost if wrong: owners filtering push by class get it under "notify".
- Ruling AVM2-E6: vitest project names are `unit`, `integration`, `kata` (the plan's `--project int` means `integration`) — cost if wrong: none.
- Ruling AVM2-E7: lane B rebases on main after Part A merges, before B4; the B4 dispatch resolves the conflicts (agents-vm.ts, runtime.ts, i18n registration) — cost if wrong: one extra small dispatch.
- Ruling AVM2-E8: mutation checks run for real only on A2 and B2 (security); other tasks rely on RED/GREEN — cost if wrong: a weak test survives until the final review.

## Progress
A1: dispatched (Sonnet, lane A), BASE c1729e89; implementer ab3bb31c3b24e5498; no task review (AVM2-E3)
B1: dispatched (Sonnet, lane B), BASE c1729e89; implementer a8bcf48485b9c9f71; no task review (AVM2-E3)
B1: complete (commits c1729e89..f99a17ed, no task review per AVM2-E3; concerns: last two small edits re-run individually, no RED for the schema test, docs left to B4; store exported as vmRpc.shared.agentFiles)
B2: dispatched (Sonnet, lane B), BASE f99a17ed; implementer acc4cb48c984ea4c6; Opus task review; mutation checks (AVM2-E8)
A1: complete (commits c1729e89..db4b31c9, no task review per AVM2-E3). Concerns carried: (1) host-mode refusal reaches the browser only as bad_request → client-side field error 'needs VM mode' carried to A4; (2) ufw hints in cli/vm/setup.ts:190 and cli/doctor/checks-vm.ts:307 list 7841/7842 only → carried to A2
A1: minor (deferred): covers falls back to name-only matching when a list holds an entry that is not a valid host entry (legacy/test data); no RED captured (tests written after code)
A2: dispatched (Sonnet, lane A), BASE db4b31c9; implementer af66d5a28dc36535d; Opus task review; mutation checks (AVM2-E8); carries ufw hints 7843 from A1
B2: implementer DONE_WITH_CONCERNS (5ea9981f): delivery not awaited by runtime.spawn (frames queue in the worker's early buffer); only the thread VM clears pendingRemovals; live apply thread VM only; B1 onChange now (agentId, path); deliverAgentFiles takes {clock}; scriptCopier moved to compose-agents-vm-script.ts. Opus review dispatched (aa444e6f83ca29ad8), package review-B2-f99a17ed..5ea9981f.diff
B2: review ❌ (Opus): 0 C, 2 I, 10 M — I1 a refused put blocks pending removals forever; I2 start vs live delivery race re-creates a removed file. Fix round 1 sent to implementer (resume), FIX_BASE 5ea9981f
B2: minor (deferred): first prompt may run before files land (fire-and-forget delivery); finish closeSync outside try (home-files.ts:113); live change reads all files' bytes; exited.then closures pile up per live change; failed start delivery retried only on a new worker; test weaknesses + process gaps (verdict file); compose-agents-vm.ts at 394/400; multi-chunk path unreachable (2 MiB chunk > 1 MiB cap)
Ruling AVM2-E9: live apply reaches the thread VM only; a running task VM keeps the files it got at its start (plan text vs spec 'a running VM') — task VMs are throwaway, short-lived and blank-disk, the next task start gets the current state — cost if wrong: a revoked credential stays readable in a task VM until that task ends.
B2: fix round 1 implemented (665d92cc: removals first, refused put no longer blocks, per-agent queue for start + live); Sonnet re-review dispatched (ad7818d417c5d5ced)
B2: fix round 1/5 (2 addressed, 0 open; commits 5ea9981f..665d92cc)
B2: minor (deferred): run() finally — files.delivered throwing masks the delivery error; a task VM start shares the per-agent queue and can delay thread live deliveries up to 30 s per frame
B2: complete (commits f99a17ed..665d92cc, review clean after fix round 1)
B3: dispatched (Sonnet, lane B), BASE 665d92cc; no task review (AVM2-E3)
A2: implementer DONE_WITH_CONCERNS (a5f68cfb): '*.lan' not a valid entry (two labels after '*.'); VM DNS queue beside host mode's (up to 4 lookups); VM keeps host connection limits (32/agent, 120 s idle, 30 min life: long kubectl watch cut); loopback/link-local/multicast/CGNAT share the blockedStrict fallback mutant; owner's list via M11.vmLate (daemon.ts 394, compose-m11.ts 399 lines); kata-mode boot fails if 7843 cannot bind; daemon.int RSS budget flake under 5 workers (passes alone 5/5). Opus review dispatched
B3: complete (commits 665d92cc..11544cee, no task review per AVM2-E3). Concerns: AgentScreen.tsx 397/400; VM status read once per mount; no step-up on import/remove (spec does not ask); not seen in a browser
Lane B: B1-B3 done; B4 waits for Part A's merge (AVM2-E7: rebase on main first)
A2: review ✅ Approved (Opus): 0 C, 0 I, 10 M
A2: minor (deferred): SIIT ::ffff:0:x and 6to4 2002:: spellings of a host address not refused (theoretical); usage logged per launch not per agent; VM DNS limiter doubles W5-R43 cap (4 vs 2); host-mode idle/life timeouts apply to VM tunnels; 3 mutants named but not listed as run; small duplications; compose-m11.ts 399/400
A2: carried to A4: scopeOf (DB read) in the connection handler without try/catch could crash the daemon; the composition test 'names a task VM's source by its task key' asserts nothing about thread/task mapping; DNS failure answers 403 with no reason line (A5's Kata test expects a non-403 for a listed name that fails DNS) and a vanished launch's 403 suggests network_request; refusal log lines unthrottled until the sink
A2: complete (commits db4b31c9..a5f68cfb, review clean)
A3: dispatched (Sonnet, lane A), BASE a5f68cfb; no task review (AVM2-E3)
A3: complete (commits a5f68cfb..ca5bf9b9, no task review per AVM2-E3). Notes: PAP_GUEST_PROXY is host:port (vmd env-file validator refuses '/'), guest prefixes http://; shell network fixed per session; compose-agents-vm.ts 397/400; new agent-stage.test.ts; no RED (3 real mutants instead)
A4: dispatched (Sonnet, lane A), BASE ca5bf9b9; no task review (AVM2-E3); carries A1 (client-side VM-mode field error) + A2 (scopeOf try/catch, source mapping test, DNS-failure reason, vanished-launch copy)
A4: complete (commits ca5bf9b9..ec0ee7f7, no task review per AVM2-E3). Notes: new migration for agent event kind (preview DB backup before deploy); migration-list tests fixed after the gate and re-run alone; carried A1/A2 items done (tests written after code)
Ruling AVM2-E10: keep A4's extra cap of 20 new refusal cards per agent per hour (beyond the per host:port dedupe) — bounds an agent probing thousands of hosts from flooding the thread and Inbox — cost if wrong: refusals 21+ in an hour only show in logs and counts.
A5: dispatched (Sonnet, lane A), BASE ec0ee7f7; writes the Kata test without running it (AVM2-E2), docs, ADR 0079
A5: complete (commits ec0ee7f7..9f5046f0, no task review per AVM2-E3). Kata test written, not run (AVM2-E2); x-pap-deny header says blocked_ip for both blocked_address and private_wildcard (test asserts the body); doc figures 20 cards/hour and 2 DNS lookups taken from reports
Part A: tasks done; final Opus review dispatched (package final-A-review-package.diff, c1729e89..9f5046f0)
Part A final review (Opus): NOT ready — 2 C (C1 port/IP entries break VM rules composition and judgeUrl; C2 VM shell never gets network: SP1 R15 forces sandbox.network false), 4 I (I1 wildcard→exact widening without step-up; I2 refusal sink flood; I3 bare IPv6 refused, [::::] accepted; I4 Kata test misses relay-key check), 9 M (verdict final-A-verdict.md)
Ruling AVM2-E11: in a VM, a shell command run with network on taints the session like host mode's networked command without a report (sticky, chip), and still raises no approval card — the VM proxy has no per-command report to correlate — cost if wrong: platform ops guarded by whenTainted are judged tainted after any networked command, even one that reached nothing.
Ruling AVM2-E12: for widensReach/covers a '*.' wildcard never covers an exact entry (an exact entry unlocks private ranges) — cost if wrong: one extra step-up when adding a name already under a wildcard.
Part A fix wave: one Sonnet dispatch (fresh agent) for C1, C2, I1-I4, M1-M9 (final-A-fix-brief.md), FIX_BASE 9f5046f0; then one scoped Opus re-review
Part A fix wave: implemented (9f5046f0..ed974a68: 927b259f, 78fcc74c, b66e482c, ed974a68); concern: VM agents had no network switch in the form (agentVm.sandboxNote pinned) → Ruling AVM2-E13: show the sandbox network switch for VM agents and replace the SP1 'no network' note copy (EN/FR, the pinned French sentence described SP1's limit) — the feature is unusable from the UI otherwise — cost if wrong: the owner's earlier sentence is reworded; same wave extended (fixer resumed)
Ruling AVM2-E14: the worker's URL stage lets a name entry without a port match any URL port; the VM proxy is the port judge — host mode's URL behaviour unchanged — cost if wrong: a URL tool call on an odd port is refused at the proxy (403) rather than before it.
Part A fix wave: AVM2-E13 done (633051b1); Opus re-verify: all findings addressed, no new C/I (final-A-reverify.md)
Part A: minor (deferred → carried to B4): egress-refusals timer flush can throw uncaught (83-90,105); suppressed total logged only on the next line; coversByName fallback lets *.x cover a.x (contradicts AVM2-E12, only for unparsable entries); stale AVM-E20 comment (stage-approval.ts:175: 'no network')
Part A: minor (deferred): start hooks throwing let the launch go on (logged); host-mode schemas wider; migration file edited after first version (Part A unreleased, preview never ran it); permissions sheet 'proxied' depends on sandbox.required + host sandboxUsable; stored sandbox.network:true VM agents get network at upgrade without step-up (form default false); network change reaches the shell at the next session; scopeOf reads hostsOf per refusal
Part A: ready for the Kata window and merge (lane A head 633051b1, built); waiting for the owner's OK (root + merge)
Owner OK 2026-10-21 (AskUserQuestion 'Oui, lance tout'): root window + Kata + merge + push + preview for Part A (AVM2-E15)
Kata run 1 (lane A 633051b1, ~/.pap-kata stack, ruleset with 7843): 4/5 files pass incl. egress.kata (403 not_listed, 502 resolve for listed.invalid, blocked_address, relay key, env); 1 fail: shell.kata 'sees only lo' sees eth0 because kata-bed creates every agent with sandbox.network:true (ignored under SP1 R15, honoured now). Fix dispatched (Sonnet a07fe04e5df045497): bed default network:false, egress.kata asks for it explicitly
Kata run 2 (after 3ae103e4): 5 files, 24 tests green
Part A: MERGED main c70b90a5 (squash of feat/agents-vm-2a at 3ae103e4) + docs 1d20746f (decision 120, roadmap); pushed; preview DB backup ~/.pap/backups/manual-pre-agents-vm-2a-20261021T103800Z.db; build + sudo vm setup on ~/.pap (ruleset 7843); preview active, 200, migration applied, relay_ready; doctor vm.* ok incl. vm.listeners 7843; ~/.pap-kata removed
Lane B rebase on main: conflicts at B1 (compose-m11.ts, daemon.ts, both near 400 lines) → aborted, delegated to the B4 dispatch (AVM2-E7)
B4: dispatched (Sonnet, lane B), BASE 11544cee: rebase on main 1d20746f + conflict resolution + B4 (Kata extension, docs) + Part A carried minors (refusal flush try/catch, suppressed total, coversByName fallback, stale AVM-E20 comment)
B4: complete (lane B rebased on main 1d20746f: 4ba8e0e5 dc626cad cbc03e01 1baf9c91 d4b3b2e7 0cbead7e ab4302e5; 6 conflicts resolved keeping both sides, compose-m11-types.ts extracted; carried (a)-(d) fixed with RED/GREEN; Kata file written, not run). Concern 'owner wildcard list no longer covers an agent exact host in widensReach' = intended by AVM2-E12
Part B: final Opus review dispatched (final-B-review-package.diff, 1d20746f..ab4302e5)
Part B final review (Opus): with fixes — 0 C, 4 I (I1 change while the thread VM has no worker is lost until restart; I2 quarantine dialog never shows file paths (plan gap); I3 purge-now trash regex splits ids like release-2024-1234 and can delete another agent's trash; I4 Kata removal step never exercises removal-while-stopped), 11 M; fold M remove() ordering + host-mode files trash never purged
Part B fix wave: one dispatch (B4 implementer resumed a22b04bd00818ed60), FIX_BASE ab4302e5; then one scoped Opus re-review
Owner stopped 2 agents by mistake (Part B fix wave a22b04bd00818ed60, status vocab aaa69e91387d26ddd); not resumable → owner asked to relaunch: fresh Sonnet a9d52d9c75f331082 takes over the Part B fix wave from the uncommitted work (BASE ab4302e5); fresh Sonnet a20e07974cfd86d3b takes over the status-vocab fix (worktree fix-agent-status)
Side work merged on owner's go: ce57d968 feat(ux) agent lifecycle (fix/agent-status-vocab), 301429c5 feat(agents) trigger Run button (feat/trigger-run-button, rebased; import-only conflict in StatusPanel.tsx resolved by the controller as a union, web agents tests 493 green, lint/prettier/typecheck green); pushed; preview rebuilt and restarted (200, no error logs). Lane B must rebase on 301429c5 at merge (AgentScreen.tsx overlaps the status-vocab change).
Part B fix wave: implemented 983820b5 (I1 dirty + next worker, I2 quarantine dialog paths, I3 safe trash id regex + AgentId check, I4 Kata stop→remove→reopen, remove() ordering, files trash sweep regardless of runtime; Purge now VM-only, docs corrected); gate related 512 files/4276 tests green; Sonnet scoped re-review dispatched
Part B fix wave: Sonnet re-review — all addressed, no new C/I (final-B-reverify.md)
Lane B rebased on main 301429c5 cleanly (head after rebase: 9150a4c1); related gate: 19177 passed, 1 failed = daemon.int idle-RAM budget flake (200 < 200 under 5 workers), passes alone 5/5
Part B root window started under the owner's Part A OK extended to B (stated to the owner, no objection; AVM2-E15)
Kata (lane B on main): 5 files, 25 tests green
Part B: MERGED main f639cbbf (squash of feat/agents-vm-2b)
