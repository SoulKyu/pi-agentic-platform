# UX-1 rulings

Pre-dispatch rulings (controller, 2026-10-28) and execution rulings from the SDD ledger (`ux-1-sdd-ledger.md`).


- PF-A (T3, T6): no file under `apps/web/src/stores/` imports a feature. The knowledge "enabled" map lives in a new `apps/web/src/stores/knowledge-enabled.ts` (store layer); `KnowledgeChip` and `QuoteToolbar` import it, and `reply-tools-reset.ts` resets it from there.
- PF-B (T6): Escape closes the quote toolbar/strip (spec §4.3). While the toolbar or strip is mounted, `useQuoteSelection` adds a capture-phase `document` keydown listener: on Escape it clears the selection (`getSelection()?.removeAllRanges()`) and unmounts the toolbar, and does not stop the run. Test: Escape with focus in the composer and in the transcript closes the toolbar and does not call `session.stop`; the NEXT Escape (toolbar gone) does stop the run as today.
- PF-C (all): the plan's builder-level refinements R6, R8, R16, R18, R23 are accepted as written. Planner Q1 is settled by default: a project trigger task session opened in a tab keeps TO TERMINAL.
- PF-D (T1): T1's Files also include `apps/daemon/src/modules/skills/rpc.ts` (the `SkillsRpc` `Pick` gains `"templates.save"`), every `createSkillsModule` caller in tests (e.g. `compose-pi.box-root.test.ts`) gets an `audit` stub, and `SkillsServiceDeps.audit` becomes required.
- PF-E (T5): the `docs/agents/e2e.md` journey count and J17 line and the `docs/agents/terminal.md` hand-off text land in T5 (not T6), and T5's gate runs `scripts/docs-truth.test.ts`.
- PF-F (T1, T5): T5 updates every existing fake of `TerminalScreen` it finds; builders un-export symbols nothing outside their file uses (knip must stay green).
- PF-G (T2): T2 also creates `apps/daemon/src/modules/sessions/snapshot.cost.test.ts`; `composeSessionCost` reads `runs.port`, not `RunsService` itself.

## Execution rulings

- Ruling: planner Q1 — a project trigger task session keeps TO TERMINAL (it already has the Terminal surface button; hiding it needs a session-type field on the stream, a third daemon change) — owner chose the default flow; cost if wrong: one button visible on task sessions, nothing runs before Enter.
- Ruling: PF-A store imports a feature → new stores/knowledge-enabled.ts — AGENTS.md module boundaries — cost if wrong: one extra small store file.
- Ruling: PF-B Escape closes the quote toolbar without stopping the run (spec §4.3) — plan only kept Escape from stopping the run — cost if wrong: a capture listener while a selection toolbar shows.
- Ruling: PF-C builder refinements R6 R8 R16 R18 R23 accepted; Q1 default kept — builder-level per spec §6 — cost if wrong: rework of the named refinement.
- Ruling: PF-D T1 wiring (SkillsRpc Pick, audit stubs, audit required) — plan omission — cost if wrong: none (typecheck would catch).
- Ruling: PF-E docs-truth timing moves e2e.md/terminal.md to T5 — keeps each task's gate green — cost if wrong: none.
- Ruling: PF-F TerminalScreen fakes updated, unused exports dropped — knip gate — cost if wrong: none.
- Ruling: PF-G T2 creates snapshot.cost.test.ts, composeSessionCost reads runs.port — module boundary — cost if wrong: none.
- Task 2: review Approved (Sonnet). Ruling: composeSessionCost takes Pick<RunsService,"port"|"peek"> instead of runs.port alone (PF-G) — peek exists only on RunsService, listeners still go through runs.port — cost if wrong: a compose file names RunsService.
- Task 3: review Approved (Sonnet). Ruling: null place.cwd → base=root, roots=[root] — fail-safe, daemon file rules and T4 scope still decide — cost if wrong: relative paths resolve from the project root instead of the session folder in that rare case.
- Task 4: review Approved (Sonnet). Ruling: recogniser tightened (relative paths need a known extension or Dockerfile/Makefile; `a/b` tokens stay text) — R14 "may tighten, never widen" — cost if wrong: extensionless relative files (bin/run, go.mod, .gitignore) do not link.
- Ruling: UX1-R24 amended — the shared in-flight promise is returned only for the identical text of the same session; a different text while one is in flight answers a busy outcome shown as "Nothing was typed" — spec §4.2 status must be true — cost if wrong: a second click during a slow create must be repeated.
- Controller: compiler-gate.test.ts fails on PathText.tsx and ShellBlock.tsx ("compiles with no bailout", default in a destructured parameter) — introduced by T4/T5, missed because `vitest related` does not reach compiler-gate.test.ts. Ruling: fixed in Task 6's fix round (blocks the lot gate); every later web task's gate adds `pnpm exec vitest run --project unit apps/web/src/compiler-gate.test.ts` — cost if wrong: none.
- Task 6: review Approved (Sonnet). Ruling: overlayOpen keyed on [data-closes-on-escape] accepted (eager literal would break the markers row) — cost if wrong: none, same behaviour. Escape tests in routes/shell accepted (boundaries).
- Ruling: no separate scoped re-review of 52aaa4ab — the Opus whole-branch final review covers it explicitly — cost if wrong: none (the final review is stricter).
- Ruling: I1 is resolved by MAKING THE SPEC TRUE, not by changing the copy — spec §4.5 (owner-approved, decision 138) promises templates reach boxes and agents with the next Pi profile image build; build() gains the `prompts/` copy like `skills/` (one line, a copied root so the fingerprint follows, the existing secret scan refuses a template holding a known secret); the dialog copy and skills.md stay, made precise — boxes run on host-made profile images and pap is moving every project into boxes (B4), so a host-only template would be near useless — cost if wrong: every profile image rebuilds once at its next start after the merge; a template holding a vault value refuses the build with the existing "a Pi profile file holds a secret" message.
- Ruling: residual minor parked — a template name containing "credentials" is valid for PromptTemplateName but dropped from the profile by DENIED_NAME (only an agent_profile_skipped log) — cost if wrong: such a template stays host-only; follow-up: refuse those names in the contract or document it.
