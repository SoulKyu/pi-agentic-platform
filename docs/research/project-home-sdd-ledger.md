# SDD ledger — plan: docs/plans/2026-10-15-project-home.md

Spec: docs/specs/2026-10-15-project-home-design.md (decision 85). Owner approved plan + subagent-driven execution 2026-10-15.
Worktrees: track 1 `.worktrees/feat-ph` (feat/project-home), track 2 `.worktrees/feat-ph-web` (feat/project-home-web), both off main 177dce9.
Models (owner-approved table): all implementers Sonnet; T1 reviewer Opus, T2–T12 reviewers Sonnet; final whole-branch review Opus. No Haiku. Fix-round 4–5 escalation to Opus NOT pre-approved for this run: ask the owner first.
Fix rounds: Critical/Important + spec ❌ only; minors parked here, one sweep before the final review.

## Pre-flight scan (2026-10-15)

Shared files / interfaces between tasks:

| Tasks | Shared | Finding |
|---|---|---|
| T1 → T2 | `contracts/shell.ts` (`ProjectView`), `projects/service.ts`, `projects/index.ts` | sequential on track 1; T2 extends T1's service (`all`) — consistent |
| T2 → T3 | `ProjectSwitcher.tsx` + test; `ProjectSummary.unused`, `listedProjects` | sequential on track 1 — consistent |
| T1 → T3 | `methods["projects.add"]`, error codes (now incl. `read_only`, PH15) | T3 maps `read_only` already — consistent |
| T3 ↔ T5 | `routes/shell/AppShell.tsx` (host mount vs sign-out reset) | cross-track: JOIN reconciles (plan lists it) |
| T3 ↔ T7 | `i18n/index.ts`, `catalog-keys.test.ts` | cross-track: JOIN reconciles (plan lists it) |
| T3 ↔ T9 | `i18n/catalog/shell.ts` | cross-track: JOIN reconciles (plan lists it) |
| T3 → T11 | `build-output.int.test.ts` | T11 after JOIN — sequential |
| T5 → T9 → T10 | `routes/shell/pane-renderers.tsx` (TriggerPane, openCompare, home renderer) | sequential (track 2 then J) |
| T5 → T7 | `NewLanePrefill.title?`, `TriggerPrefill` | same track, T7 consumes T5 — consistent |
| T7 → T8 → T10 → T11 | `catalog/home.ts`, `lazy-catalog.home.test.ts`, `HomeActions`/`HomeTarget` | sequential — consistent |
| T4 → T11 | `HomeLayout`, `DEFAULT_HOME_LAYOUT` | T11 after JOIN — consistent |
| T6 → T10 | `usePaletteRequest` | T10 after JOIN — consistent |
| T9 → T10 | command `mobile.inbox.open` | T10 after JOIN — consistent |
| T10 → T11 | `ProjectHome.tsx`, `HomePane.tsx`, `home-bed.tsx`, ProjectHome tests | sequential — consistent |
| T9 / T5 | `AppShell.test.tsx` vs `AppShell.signout.test.tsx` | same track, different files — consistent |

Per-task self-consistency (Files block vs every `git add` in the task's commit step, scripted check): T1–T12 all ✅ (no committed file missing from its Files block). Step code of each task was self-reviewed by the Opus planner; not re-read line by line by the controller (cost) — the per-task review is the net.

Plan-text checks: placeholder scan clean ("ListTodo" false positive). Literal invisible characters (U+200B, U+202E) in T5 test code → rewritten as `\u200b`/`\u202e` escapes (commit 177dce9).

Ruling: `projects.add` declares `read_only` as a fourth error (PH15) — the service maps a newer-pap database refusal to it and the automation methods declare it the same way; spec §4 lists three codes — cost if wrong: one extra declared code, harmless.
Ruling: An added root that is an ANCESTOR of `$PAP_HOME`/Pi's agent dir (e.g. `~`) is accepted — `sessions.create` already allows it and the files module's deny set (`kernel/fs/deny-set.ts`) refuses pap's and Pi's private files under any root — cost if wrong: a browsable `~` exposes non-private dotfiles, as `sessions.create { cwd: "~" }` already does.

## Execution
T1: dispatched (Sonnet, BASE 177dce9, track 1)
T5: dispatched (Sonnet, BASE 177dce9, track 2)
T1: implementer DONE_WITH_CONCERNS 915b7be (int test steps:[] → [{text:'ok'}]; realOrResolved unpinned) — review dispatched (Opus)
T5: implementer DONE 5b199d6 (test uses title ?? "" for TS2488; one EnvironmentTeardownError not repeated) — review dispatched (Sonnet)
T1: review (Opus) — spec ✅; Important 1: realOrResolved + `real` operand unpinned by tests. Fix round 1 sent (test-only, + minor 1 control-char test same file). FIX_BASE 915b7be
T1: minor (deferred): scope operand not pinned (defence in depth, unreachable case — no test needed)
T1: minor (deferred): end-to-end filing parity (session from sessions.create filed under added project) not asserted — holds by construction
T1: minor (deferred): shell.test.ts:157 title says "three refusals", asserts four codes
T1: minor (deferred, OWNER NOTE): dotfiles `~/.git` → adding any folder under ~ files it under project $HOME (contains $PAP_HOME); same as sessions.create today; files boundary refuses pap_home/pi_private by name; vcs filtering at such a root not checked
T5: review (Sonnet) — Important 1: literal U+200B/U+202E in launch-text.test.ts; Important 2: over-long first line tail lost from lane description. Fix round 1 sent. FIX_BASE 5b199d6
T5: minor (deferred → T10 dispatch): TriggerPane useState initializer never re-peeks for an already-mounted `new:<id>` pane; stale prefill entry stays — T10 must handle (key the pane or re-peek) + integration test
T5: minor (deferred): splitLaunchText splits only on \r?\n; lone \r / U+2028 glue words after stripping
T5: minor (deferred): 20 s timeouts reused in trigger-prefill / editor tests; one EnvironmentTeardownError seen once
T1: fix round 1/5 (2 addressed + minor 1, 0 open — test-only 20 lines, controller re-verified: focused test 10/10, 3 mutation outputs in report; commits 915b7be..aaa92c9)
Task 1: complete (commits 177dce9..aaa92c9, review clean)
T2: dispatched (Sonnet, BASE aaa92c9, track 1)
T5: fix round 1/5 (2 addressed, 0 open — escapes; clipped first line kept in description; commits 5b199d6..7af26d4)
Task 5: complete (commits 177dce9..7af26d4, review clean)
T6: dispatched (Sonnet, BASE 7af26d4, track 2)
T2: implementer DONE 0111315 (concern: two-owner test on the fake port; real all() = store.list(ownerId)) — review dispatched (Sonnet)
T2: review (Sonnet) — Approved, spec ✅, 0 C/I
T2: minor (deferred): real ProjectsService.all has no two-owner test (holds by construction: store.list filters owner)
T2: minor (deferred): past 500 snapshot projects, an unused project sorted higher can displace an active one; shell.ts:50 docstring stale ("with an active session")
T2: minor (deferred): shell-reducer evicts unused projects first past MAX_STORE_PROJECTS (unchanged code)
T2: minor (deferred): event path clearing `unused` after a first session is not pinned (harmless: list = sessions>0 || unused)
T2: minor (deferred): `unused` field lacks the brief's JSDoc in contracts shell.ts
Task 2: complete (commits aaa92c9..0111315, review clean)
T3: dispatched (Sonnet, BASE 0111315, track 1)
T6: implementer DONE 16244bb — review dispatched (Sonnet)
T6: review (Sonnet) — Approved, spec ✅, 0 C/I
T6: minor (deferred): PaletteHost passes projectName null for an unknown project → label says all projects while filtering by id
T6: minor (deferred): search request arriving while palette open keeps the old query text
T6: minor (deferred): search mode still builds full item list + useTasksFeed(open) (wasted work)
Task 6: complete (commits 7af26d4..16244bb, review clean)
T7: dispatched (Sonnet, BASE 16244bb, track 2)
T3: implementer DONE 5e23f7a (initial bundle 223.1 KB, dialog chunk 2.7 KB) — review dispatched (Sonnet)
T3: review (Sonnet) — Important 1: stale projects.add/lanes.preview response lands after path edit (plan-mandated); Important 2: disabled Add/Check/Cancel without visible reason + aria-describedby, Escape blocked while busy (plan-mandated)
Ruling: T3 plan-mandated findings fixed anyway — spec §3.2/§7 ("disabled says why", aria-describedby) and the stale-response lesson bind over the plan's prescribed code; Cancel/Escape allowed while busy (late response dropped; PH2 accepts a checked-then-cancelled project staying) — cost if wrong: a few lazy strings, one ref token
T3: fix round 1 sent. FIX_BASE 5e23f7a
T3: minor (deferred): no tests for double Check/Enter during busy, re-Check clearing problem; no mutation on busy guard
T3: minor (deferred): no test for host hand-off (ask(cb) runs onAdded after choose; close clears cb) — T11 may cover
T3: minor (deferred): import order (catalog-keys.test add-project after lane-commit; AppShell AddProjectHost after MobileShell)
T3: minor (deferred): failed lanes.preview indistinguishable from transport error (PH12-acceptable)
T7: implementer DONE_WITH_CONCERNS 3763bb0 (SHORTCUTS tagged @public for knip — remove at T10/T11) — review dispatched (Sonnet)
T7: review (Sonnet) — Approved, spec ✅, 0 C/I
T7: minor (deferred, SWEEP CANDIDATE): StatusLine links always preventDefault → ctrl/cmd/middle-click "open in new tab" broken on real <a href>; skip preventDefault/open on modifier or button!==0
T7: minor (deferred): use-spend swallows rejection + safeParse failure silently (no comment/log)
T7: minor (deferred): remove @public on testing/home-actions.ts SHORTCUTS once T10/T11 consume it
T7: minor (deferred): spend part appears after RPC → layout shift; no test for unmount-before-response / safeParse rejection
Task 7: complete (commits 16244bb..3763bb0, review clean)
T8: dispatched (Sonnet, BASE 3763bb0, track 2)
T3: fix round 1/5 (2 addressed, 0 open — request token drops stale/unmounted answers; visible disabled reasons + aria-describedby; Cancel/Escape while busy; initial bundle 223.1 KB; commits 5e23f7a..521bd07)
T3: minor (deferred): Escape/X while busy untested (only Cancel); hint ids hard-coded
Task 3: complete (commits 0111315..521bd07, review clean)
T4: dispatched (Sonnet, BASE 521bd07, track 1)
T8: implementer DONE_WITH_CONCERNS b2a1237 (60 s setInterval age clock per brief; archived-lanes stale drop untested) — review dispatched (Sonnet)
FLAKE: EnvironmentTeardownError seen twice in test:unit (T5 automation/shell subset; T8 routes/shell/NewLaneHost.test.tsx, untouched file) — root-fix before the final gate (rule C)
T8: review (Sonnet) — spec ✅; Important 1: lanes.listArchived failure swallowed silently (plan-mandated); 60 s age interval OK (codebase precedent)
Ruling: T8 plan-mandated silent catch fixed anyway — a hidden failure drops archived-only fan-outs that §3.4 promises to reopen; one muted line + Retry (click, no polling) — cost if wrong: two lazy strings
T8: fix round 1 sent (+ stale-drop test). FIX_BASE b2a1237
T8: minor (deferred): only the first page of archived lanes read (hasMore ignored); a lane archived while home mounted vanishes until remount
T8: minor (deferred): RecentWork test titled "type, state and age" asserts no age; markup-as-text test covers session titles only; no project chip for an unlisted project under All projects (untested)
T4: implementer DONE e64bd3e (touched settings/service.test.ts + lazy-catalog.test.tsx for the gate; lessons checklist not run line by line) — review dispatched (Sonnet)
T4: review (Sonnet) — Approved, spec ✅, 0 C/I
T4: minor (deferred): no test for unknown keys inside `home` (zod strips; correct but unasserted)
T4: minor (deferred): one malformed `home` entry resets the whole object to show-all (coarse fallback, per brief)
T4: minor (deferred): HomeSection spreads render-time account snapshot (same as sibling sections)
Task 4: complete (commits 521bd07..e64bd3e, review clean) — TRACK 1 DONE
Plan: FLAKE (EnvironmentTeardownError via onUserConsoleLog, NewLaneHost.test.tsx / automation+shell subset; seen only on track 2 since T5 — T5 touched NewLaneDialog/TriggerEditor/AppShell) → root-fix on the joined branch right after the JOIN, before T10 (Sonnet)
T8: fix round 1/5 (1 addressed, 0 open — failed+retry on archived fetch, stale-answer tests; commits b2a1237..a1f0bf9)
T8: minor (deferred): "no warning after unmount" test cannot fail (React 18+); failed line stays visible during a retry
Task 8: complete (commits 3763bb0..a1f0bf9, review clean)
T9: dispatched (Sonnet, BASE a1f0bf9, track 2)
T9: implementer DONE_WITH_CONCERNS e545ef7 (3 brief test defects fixed: phone Lists menu is a dialog of buttons, settings route params, Mark inside "pap" link) — review dispatched (Sonnet)
BUNDLE: track 1 alone 223.1 KB; track 2 alone 224.0 KB (> plan's 223.7 = 222.7 + 1.0 "noise"); CI budget (budgets.json) is 300 KB. Plan says: move code lazy, else stop and ask the owner → owner asked 2026-10-15 (threshold), pending
OWNER DECISION (2026-10-15): initial bundle limit for this feature raised to ≤ 226 KB gzip (was the plan's 223.7). Dialogs, tasks board, home body stay lazy. Applies to JOIN, T11, T12 and the final review.
T9: review (Sonnet) — Important: phone logo/"+"/Settings do nothing when the path is unchanged (section resets only on pathname change). Fix round 1 sent. FIX_BASE e545ef7
T9: minor (deferred): "Keyboard shortcuts" account-menu row shows no `?` hint (Menu primitive has no shortcut field)
T9: minor (deferred): phone logo / "+" touch-target sizing unverified
T9: fix round 1/5 (1 addressed, 0 open — setSection("work") on logo/"+"/Settings; commits e545ef7..6fcaead)
Task 9: complete (commits a1f0bf9..6fcaead, review clean) — TRACK 2 DONE
JOIN: dispatched (Sonnet, brief join-brief.md, JOIN_BASE feat-ph e64bd3e + feat-ph-web 6fcaead)
JOIN: complete — 7dc9d28 `chore: join the project home tracks` (auto-merged, no conflicts; imports re-sorted). Full gate exit 0: unit 1149 files / 13950, int 182 files / 1032 (+1 skipped), build+budgets OK. Initial bundle 224.8 KB (limit 226).
FIX: NUL bytes found in implementer-common (`\u` had become \x00 in the followups source) → the "write escapes" rule read "` XXXX`"; fixed in all common files + followups + sdd-templates (likely contributed to T5's literal invisible chars)
Ruling: parked T5 minor (TriggerPane ignores a second prefill when the new:<id> pane is mounted) carried into T10 as a requirement — T10 creates the launch path that hits it — cost if wrong: small extra scope in T10
T10: dispatched (Sonnet, BASE 7dc9d28, joined branch feat-ph)
FLAKE: dispatched (Sonnet) in .worktrees/feat-ph-flake (branch fix/ph-flake at 7dc9d28) — cherry-pick onto feat/project-home when done
T10: implementer DONE_WITH_CONCERNS 7d22059 — initial bundle 227.2 KB > 226 (owner limit). Sent back BEFORE review for a lazy pass (use-launch on click, project-facts + reason strings lazy per PH12), target ≤ 225.6
FLAKE: complete — 80ba5a8 (branch fix/ph-flake, parent 7dc9d28): root cause = dev-ui gallery test in routes/shell/pane-renderers.test.tsx unmounted before 3 lazy CodeMirror chunks settled → act warning after teardown. Fix: wait for the editors' plain fallbacks to be gone. Controller verified (11-line test-only diff, selectors match packages/ui fallbacks, file 6/6). Before 1/5 failing; instrumented after: 0 late logs. CHERRY-PICK onto feat/project-home after T10 review.
FLAKE 2 (new, deferred to sweep): routes/shell/drawers.test.tsx:227-239 "tree drawer, first load" sometimes never sees the "Loading sessions" spinner within 2 s (transient-state assertion) — root-fix in the minor sweep
T10: bundle pass DONE 1a07e16 (225.2 KB: launch + project facts lazy, "use no memo" on ProjectHome/ModeChips) — review dispatched (Sonnet)
T10: review (Sonnet) — Important 1: home.launch.noLaneHost translated with stale render-time t (raw key possible), untested; Important 2: unhandled rejection in launch .then leaves busy stuck
Ruling: "use no memo" on ProjectHome/ModeChips accepted (owner's 226 KB limit; correctness safe, perf negligible) on condition that compiler-gate asserts the exact allowlist of opted-out files + a why-comment; T12 documents it in web.md — cost if wrong: two components skip compiler memo + bailout checks
T10: fix round 1 sent. FIX_BASE 1a07e16
T10: minor (deferred): a remembered Lane mode shows checked until facts answer in a non-git project (PH12-consistent)
T10: minor (deferred): `launch.*` vs `home.launch.*` key prefixes easy to confuse
T10: minor (deferred): ProjectHome.tsx onFailed={() => undefined} deserves a comment (LazyPanel notifies)
T12: carry — document the "use no memo" allowlist in docs/agents/web.md
T10: fix round 1/5 (3 addressed, 0 open — live translator in run-launch, trailing catch frees Launch, compiler-gate allowlist for "use no memo"; bundle 225.2 KB; commits 1a07e16..bde8102)
T10: minor (deferred): use-launch final .catch swallows the error without a log
Task 10: complete (commits 7dc9d28..bde8102, review clean)
FLAKE: cherry-picked onto feat/project-home as a075993 (pane-renderers.test.tsx 6/6)
T11: dispatched (Sonnet, BASE a075993, joined branch feat-ph)
FLAKE 2: dispatched (Sonnet) in .worktrees/feat-ph-flake (branch fix/ph-flake2 at a075993)
T11: implementer DONE_WITH_CONCERNS 221fbf1 (bundle 225.3 KB; build-output assertion adapted; mutation checks NOT run; Cf scan controller-verified clean) — sent back for mutation checks before review
T11: mutation checks done 30ec32b (2 survivors → tests tightened) — review dispatched (Sonnet)
T11: review (Sonnet) — Important: Terminal sticky-disabled after any terminal.create failure + double-click opens two terminals (plan-mandated)
Ruling: T11 plan-mandated sticky Terminal fixed anyway — PH12 binds (only a root refusal disables); failure becomes a notice, pending flag prevents duplicates — cost if wrong: a few lines + one string
T11: fix round 1 sent (+ Inbox badge in accessible name, root-access stale test, skip files.list when Explore hidden). FIX_BASE 30ec32b
T11: minor (deferred): dead regex `\W*"?` in build-output.int.test.ts:48; "check itself fails" test asserts Files only; files.list exactly-once per root not asserted
T11: minor (deferred, FINAL REPORT): 226 KB is a review limit, budgets.json still 300 — offer the owner to lower the CI budget
T11: fix round 1/5 (3 addressed, 0 open — Terminal failure is a notice + pending guard, Inbox count in name, root-access stale test, no files.list when Explore hidden; bundle 225.3 KB; commits 30ec32b..ef0b7af)
T11: minor (deferred): setTerminal after unmount on a late failure (harmless)
Task 11: complete (commits a075993..ef0b7af, review clean)
T12: dispatched (Sonnet, BASE ef0b7af)
FLAKE 2: complete — a1b0249 (fix/ph-flake2): spinner is a real 200 ms page timer and the test waited 2 s real time; test now fakes setTimeout/performance and asserts 199 ms none / 200 ms spinner. Never reproduced (8/8 before) — cause argued from code; 2 real mutations fail it. Controller verified (26-line test-only). CHERRY-PICK after T12's gate.
T12: implementer DONE 7986ebe (full gate green: unit 13992, int 182 files, bundle 225.3 KB; smoke NOT run) — review dispatched (Sonnet); controller runs smoke
FLAKE 2: cherry-picked onto feat/project-home (drawers.test.tsx 11/11)
SMOKE: ok on f7c915e (prompt/approval, CLI session + search, lane commit/archive, terminal, SIGTERM clean)
T12: review (Sonnet) — every claim checked against code; Important: web.md says the Add project dialog "does not close while busy" (false since T3 fix). Smoke confirmed run by controller (ok).
Ruling: T12's one-sentence doc fix folded into the minor sweep (item 11) instead of a separate fix round — same worktree, the sweep re-review verifies it — cost if wrong: none (docs)
T12: minor (deferred → sweep item 11): "chords (HomeShortcuts)" imprecise
Task 12: complete (commits ef0b7af..7986ebe, 1 Important folded into the sweep)
SWEEP: dispatched (Sonnet, BASE f7c915e) — brief sweep-brief.md (11 items)
SWEEP: DONE d99688f (11 items, gate green, bundle 225.3) — scoped re-review dispatched (Sonnet)
SWEEP: re-review — all 11 addressed, no new issues. SWEEP complete (f7c915e..d99688f)
FINAL REVIEW: dispatched (Opus) on 177dce9e8c8f2a15b6d99a2ee20cd1991c9fd959..d99688f
FINAL REVIEW (Opus): Ready to merge — With fixes. 0 Critical; Important 1: sign-out does not reset useAddProjectRequest / usePaletteRequest (cross-account continuation); Important 2: focus lost on picker → Add project… → close (§7). Minors 1–11; deferred-minor triage: none blocking.
Ruling: final fix wave = I1, I2 + cheap minors M2 (bad_request copy overstates), M3 (RecentWork new-tab links), M8 (stale launch error after project change), M9 (stale docs/comments) — one Sonnet dispatch, one scoped re-review
Ruling: final M5 (picker launches without the picked project's facts), M6 (Launch offline no reason), M7 (Archived lanes count owner-wide), M10 (failureText duplicated), M11 (226 KB not CI-enforced) parked — none is data loss or security; the dialog/editor refuse invalid launches — cost if wrong: small UX papercuts
OWNER QUESTIONS at merge: final M1 (no UI path to start a session in a subfolder / any folder anymore — spec §3.1 says project root), final M4 (projects cannot be removed; Check files a project; trigger-only projects now listed as unused) → propose follow-up "Remove from list"
FINAL FIX: dispatched (Sonnet, BASE d99688f, brief final-fix-brief.md)
PREVIEW (owner request, 2026-10-15 14:54Z): pap-preview temporarily runs the branch at d99688f from .worktrees/preview-ph (detached, built) via drop-in ~/.config/systemd/user/pap-preview.service.d/branch-preview.conf (WorkingDirectory). Backup ~/.pap/backups/manual-pre-ph-preview-2026-10-15T14-54-45Z.db. No migration. REVERT at merge: rm drop-in, daemon-reload, rebuild main, restart; remove .worktrees/preview-ph.
FINAL FIX: DONE 11b27e9 (gate green, unit 13997, bundle 225.4 KB) — scoped re-review dispatched (Sonnet)
FINAL FIX: re-review — 6/6 addressed, no new issues. FINAL REVIEW CLOSED (head 11b27e9).
FINAL GATE on 11b27e9: green — unit 1159 files / 13997, int (see log), budgets 225.4 KB, smoke ok
