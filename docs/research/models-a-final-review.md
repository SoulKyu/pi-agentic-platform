# Models batch, chain A: final review (Opus)

Whole-branch review of feat/models-picker-providers (ff6766e1..8f75402b), then its scoped re-review of the fix 80f06f7d. Chain A merged as aad544bb (decision 96). The C2 browser proof was re-run 4/4 on the tree merged with M12 before the merge.

## First review

**Merge recommendation: Ready after fixes.** One Important fix is needed: the session model menu's list sits inside a second scroll area, and no browser check covered that menu. The gate passed on 8f75402b, apart from two integration failures caused by load and by where my scratch copy lived; both passed when re-run alone.

### Spec Compliance
- Issues found: one. The session menu list scrolls inside another scroll area (I1). Everything else in chain A matches the spec, MPR1–7, 19, 21–23, 25–27, 29, MPR-C2 and MPR-C6.
- Cannot verify from the diff:
  - The agent form's picker was not driven in a real browser. It is the same component the gallery figure proved inside a modal Dialog, so the risk is low.
  - The Inbox drawer under the new flex-column Dialog body was never actually checked by eye. The ledger says C2 would do it; C2's results don't mention it.

**Focus 1: the owner's request**
- **Session menu:** reads `sessions.models`. The worker now lists through `freshAvailable` (`model-commands.ts:16-18`), so a warm worker sees changes.
- **Agent form:** `ModelPickerField cwd={null}` (`ModelFields.tsx:33-37`). Agent homes are untrusted, so global settings only is correct.
- **New lane:** `cwd={root}` (`ModelSlots.tsx:89-92`).
- **Scrolling:** C2 proved mouse, keyboard and touch in Chromium and WebKit, desktop and phone, for the gallery figure (2000 models in a modal Dialog) and the real New lane dialog. The session menu was not in C2's scope.
- **Remaining `models.overview` readers, both legitimate:**
  - `ModelMenu.tsx:68` reads it only for the default star; the list comes from `sessions.models`.
  - `PiStep.tsx:37` uses it for the first-run "Ready, default model" summary. It is not a picker.
  - Settings › Models (switches, star) is the overview's stated job. `ModelTest` and `PricingLookup` are free-text fields, not pickers.
  - No static model list remains (`sources.scan.test.ts` passes).

**Focus 2: one source.** `listAvailable` (`pi-host/src/available-models.ts:19-32`) is the only place availability is decided. The worker's old inline copy is gone.
- **Helper path** (`models-available.ts:34-43`) uses:
  - pap's credential store (`models-open.ts:63-73`), with `refreshOnCreate:false` and `allowModelNetwork:false`;
  - an explicit `refresh({allowNetwork:false})`.
- **Helper vs worker:**
  - **Environment variables:** both use `workerEnv`, so env-var keys look the same to both.
  - **Repeated `!command` runs:** Pi caches a command's result for the process lifetime (`resolve-config-value.js`), so `freshAvailable` does not re-run a worker's key command on each menu open.
  - **Extension providers:** Pi's `refresh` keeps them, so the session menu still lists them.
- **Marker tests** cover an auth.json key and a models.json key and header. A matching test shows the worker's default store does run the command. The OAuth test runs without `PI_OFFLINE` with the network guard empty.

**Focus 3: the cache** (`available.ts`, `service.ts:70-92,176-181`). All five points hold:
- **Single flight** per cwd.
- **cwd checked before the cache** (`service.ts:177`), pinned by a test where one user fills the cache and another still gets `invalid_cwd`.
- **Generation counter on every write path:** `setEnabled`, `setDefault`, `setDefaultThinking`, `config.save` (all queued), `refreshCatalog`, `setApiKey`, `logout` and `onSignedIn` each clear it; failed writes too. Each path has a test.
- **Bounds:** 32 keys with expired ones swept first (cap-crossing test). Each answer is capped at 600 000 bytes (about 19 MB at most).
- **Staleness:** the TTL counts from when a read starts, so a list is never more than 10 s old. Each picker opening fetches again; nothing is kept client-side.

**Focus 4: seams**
- **Types:** strict schema parse in the daemon (`service.ts:110`) and in the web (`use-available-models.ts:33`). Size bounds line up (provider id 128, name 256).
- **Errors:** every `models.available` failure shows one generic "failed" line with Retry. Pi's default row stays pickable when the list fails. `unknown_method` or a missing chunk shows "reload".
- **i18n:** en/fr keys and placeholders match, vous form, a space before ':' (`tronquée : affinez`), accents tested. The catalog is lazy and absent from the eager catalogs.
- **Bundle:** eager bundle 227.8 KB (+0.3 KB over A0).
- **ESLint:** boundaries are one-way (models imports no other feature). knip is clean, no orphan i18n keys, removed hooks have no callers left.

**Focus 5: parked minors.** None blocks the merge. Two of them, followed up:
- **Task 1's question, does `reload`/`refresh` throw?** Pi records the error rather than throwing (see M3).
- **5a's "A→B→A shows the cached A list":** it can't happen in the app, because the popover is modal (the project can't change while it is open) and closing it clears the state.

### Lessons checklist
| Item | Result | Evidence |
|---|---|---|
| Bounded resources | OK | `available.ts:32` and the `cache.cap` test; op caps `models-available.ts:63-68` with tests for 2100 models, 301 providers and the byte budget; `ModelList.tsx` shows 200 rows per group |
| Errors never silent | ISSUE (minor) | `use-available-models.ts:77,81` reports and shows the failure; `LazyPopover.tsx:32-37` handles chunk failures. But in the session menu the error, notice and truncated lines sit below the fold (I1) |
| Time bounded | OK | `READ_DEADLINE_MS` at `service.ts:39,179`; no new timers |
| Fail closed | OK | cwd check `service.ts:78-82`; strict parse on both sides; unreadable trust store counts as untrusted (`models-open.ts:85-91`) |
| Untrusted text | OK | `shownText` (`model-picker.vm.ts:26-37`), trigger `ModelPickerField.tsx:70,98`, group labels; rendered as React text only |
| Auth / owner on new paths | OK | `pi:read`, strict params (`contracts/models-available.ts:30-37`); `covers(caller.userId)`; the result has no key, header or path (tested) |
| Stale responses dropped | OK | `live` flag plus the cwd check in the hook; `live` in ModelMenu; cache generation counter |
| No await in check-then-act | OK | `service.ts:176-180` is synchronous up to the load |
| Mutations idempotent:false | n/a | a query, `idempotent: true` (`methods-idempotent.ts`) |
| Keys unique by construction | OK | `modelKey` JSON pair (`model-picker.vm.ts:22-23`), `saved:` prefix (`ModelList.tsx:92`); Pi removes duplicate scope matches |
| Tests seen RED | OK | per task reports (T7: 2 RED) |
| Mutation checks | OK | per task reports (T7: 4 real mutations) |
| Exact assertions | ISSUE (minor, parked) | byte-budget test uses 900–1100 bounds (`models-available.test.ts` ~141-145); the parity integration test is exact |
| No sleeps | OK | fake clock, `setImmediate` settle, `vi.waitFor` with timeouts |
| Test hygiene | OK | models bed in temp dirs, network guard, `blockedAttempts` checked in `afterEach` |
| Repo rules | OK | largest touched file 391 lines (`ModelBar.test.tsx`); no eslint directives; no AI trailers in commit messages |

### Strengths
- One decision function, called by both the worker and the helper, with a parity test against a real warm worker after a write (`host.models.int.test.ts:242`).
- The cache handles the hard cases (generation counter, cwd checked first, failed writes clear it) and every invalidation path has its own test.
- The marker tests contrast pap's store with Pi's default store, so the stated exception is proven rather than claimed.
- The fix for the clipped popover (portal to the body, modal, flex-column Dialog body) addressed the cause and was proven in a real browser.
- The smoke test exercises `models.available` through the built helper.

### Issues
#### Critical (Must Fix)
- None.

#### Important (Should Fix)
- **I1. The session menu's list is inside a second scroll area.**
  - **Where:** `apps/web/src/features/sessions/ModelMenu.tsx:182`. The wrapper `<div data-model-menu className="flex flex-col gap-s2 p-s3">` lacks `min-h-0 flex-1`.
  - **Why:** the shared list's root (`ModelList.tsx:193`) and listbox (`:250`, `max-h-popover`) can't shrink inside it. The listbox falls back to the full viewport height inside a Dialog body that is shorter.
  - **Measured:** a static probe with the built CSS and the exact DOM, 500 rows, both engines:

    | View | Listbox | Body visible | Hidden below dialog edge | Body overflow | Search box after outer scroll |
    |---|---|---|---|---|---|
    | Desktop 1280×800 | 800 px | 759 px | 87 px | 127 px | −111 px (gone) |
    | Phone sheet 390×844 | 844 px | 804 px | 86 px | 126 px | −110 px (gone) |

  - **Effect:** the error, notice and truncated lines render below the fold.
  - **Fix:** with `flex min-h-0 flex-1 flex-col gap-s2 p-s3` the listbox is 679 / 718 px, the body has no overflow and the search box stays in place.
  - **Also add:** a class-lock test (like `Dialog.test`'s flex-column test). Either add the session menu to C2 or attach the probe as evidence.
  - **Gap:** C2's scenes didn't include this surface, which the owner named.

#### Minor (Nice to Have)
- **M1. Marker tests only run offline.** `models-available.marker.test.ts:13` and `available.int.test.ts:65` set `PI_OFFLINE=1`; production helpers run without it (`supervisor/env.ts:17`). Add a variant without it, as the OAuth test does.
- **M2. Two project-level parity gaps.**
  - Spec §3 asks for a daemon + worker parity test "for one project". The integration test has no cwd or trusted project.
  - The New lane dialog asks with the project root, but the lane runs in a worktree that inherits Pi trust only under conditions (`lanes.md:167`). A lane on a foreign base can see a different list. Document it in `models.md`.
- **M3. Bad-file divergence.**
  - A corrupt settings.json: the helper ignores `unreadable` and shows the full signed-in list, while the worker's `reload()` keeps the last good selection.
  - A corrupt models.json: Pi loads an empty config and both lists drop custom providers. A warm worker now does this at the next menu open or `set_model`.
  - Document it, or follow up.
- **M4. Trigger shows the id, not the name.** `ModelPickerField.tsx:70`; spec §4 says "name, provider chip".
- **M5. Buttons inside the listbox.** The "Show N more" button (`ModelList.tsx:264-269`) sits inside `role=listbox`/`group`, which is invalid for assistive technology (the star buttons were already accepted).
- **M6. ADR overclaim.** ADR 0068:16 "Every write of Pi's files clears it" is too broad: MCP and trust writes don't. `models.md` states it correctly.
- **M7. History needs a squash merge.**
  - f6deeaf1 has a non-Conventional `merge:` subject.
  - Three original/cherry-pick pairs sit side by side: b9c3d826/2596d3ec, 3e041cf5/4bef3d71, b794b09f/e4fcbcaf.
  - Squash-merge as A0 was, or `git rebase --onto main 7380bea9`. A plain rebase replays the duplicates and the service.ts conflict.
- **M8. Phone Escape race** (from the C2 note): reopening the sheet during its exit animation lets a hardware Escape close the parent dialog. Follow-up.

### Gate (scratch copy of 8f75402b, heavy-gate lock, `--maxWorkers=7`, integration tests in `env -i … CI=1`)

| Step | Result |
|---|---|
| lint, format:check, knip | pass |
| typecheck | pass. A fresh clone first needs `pnpm --filter @pap/contracts build`, because the root `tsc` reads the contracts `dist/`. This predates chain A. |
| test:unit | 1486 files, 17697 passed, 2 skipped |
| test:int, run 1 | 218/220 files; 1 failed, 1276 passed, 18 skipped |
| `agent-budget.int.test.ts` | Failed in run 1 (`['queued']` vs `['failed']` at the 60 s wait, host loaded by other lanes' gates). Alone: 1/1 passed. |
| `kernel/sandbox/probe.int.test.ts` | Failed in run 1 and alone because its setup asserts the repo copy is not under `tmpdir()`, and my copy was under /tmp. With `TMPDIR=/tmp/claude-1000/final-a-tmpdir`: 16/16 passed. |
| build | pass |
| budgets | 227.8 KB gzip, budget 300 |
| smoke | ok, including "models.available lists 17 anthropic model(s) and none of openai" |

All chain A integration files passed in run 1: `available.int`, `host.models.int`, the models service and login-flow tests. The stderr noise in the unit output (pi-host policy lines, pap-helper cerebras lines) comes from untouched, pre-existing tests.

### Merge readiness (after M12)
**Trial:** I merged the three M12 lanes onto main myself (union-resolving M12's own conflicts in `decisions-log.md` and `compose-push.stubs.test.ts`), then cherry-picked chain A as one squashed commit.
- **Only conflict from chain A:** `apps/web/src/i18n/index.ts`, two hunks (the import after `memoryEn` and the end of the `MessageKey` union). Keep both sides.
- **Merged cleanly:** `packages/contracts/src/index.ts`, `methods-idempotent.ts`.
- **On the trial tree:** lint, format, typecheck (web, daemon, root), knip and build pass. Unit: 1574/1575 files; the one failure was the M12 file my own conflict resolution broke. The three integration files (`build-output`, `build-output.pwa`, `available.int`) pass.
- **Bundle:** eager bundle 230.7 KB with M12 alone, 230.8 KB with chain A. Service worker 3.7 → 3.8 KB of 6.

**Re-check after the rebase:**
1. Full gate, C2 scene 2, and the preview's agent form.
2. Lazy-chunk "reload" path together with M12's service worker (real browser).
3. Inbox drawer inside the flex-column Dialog body, now that M12 adds `scrollIntoView` in `InboxPanel`.
4. `/settings/$section` `models` link (M12 changed `sections.tsx`).
5. Palette "New lane" command (M12 changed `shell-commands.ts`).
6. Optionally add `modelPickerFr` to M12's `vous-register.test.ts`.
7. Decision-log numbering.

### Assessment
**Task quality:** Needs fixes.
**Reasoning:** The architecture, cache and security properties hold and are well tested, but the session menu, one of the three surfaces the owner named, has a nested scroll with hidden content that no browser check caught.

**Merge recommendation: Ready after fixes**:
1. I1, the one-line `ModelMenu.tsx:182` wrapper change with a class-lock test and browser evidence.
2. Optionally M1, a cheap test without `PI_OFFLINE`.

M2–M8 can be follow-ups.

Probe and log files are in `/tmp/claude-1000/-home-ubuntu-Workspace-soulkyu-pi-agentic-platform/5131dd4e-de2d-4935-a5a9-3de6a37da440/scratchpad/`: `final-a-probe/probe.mjs`, `final-a-probe/result.json`, `final-a-gate.log`, `final-a-gate2.log`, `final-a-gate3.log`, `final-a-trial.log`. Scratch copies are deleted; the worktree is untouched.

**Tips for future gates in fresh scratch copies** (I did not write them to MEMORY.md; that's yours to decide):
- An offline `pnpm install` under /tmp needs `--store-dir ~/.local/share/pnpm/store/v10`, or it creates `/tmp/.pnpm-store`.
- Run `pnpm --filter @pap/contracts build` before typecheck.
- `probe.int` needs `TMPDIR` set somewhere other than the copy's own location when the copy is under /tmp.

## Scoped re-review

**Chain A: Ready to merge.** The scoped re-review of 80f06f7d found all five items fixed, and nothing in this scope blocks the merge.

I checked out 80f06f7d in a scratch copy, installed offline and built the web app. The vitest runs took the heavy-gate lock, in a clean environment without `PI_OFFLINE`.

**I1 (session menu scrolling): fixed in both engines.**
The probe now reads the menu's wrapper class straight from `ModelMenu.tsx` at 80f06f7d (`flex min-h-0 flex-1 flex-col gap-s2 p-s3`) and runs against the built CSS.

| View (Chromium and WebKit, same numbers) | Before (8f75402b) | Now (80f06f7d) |
|---|---|---|
| Desktop 1280×800, list height | 800 px, 87 px hidden below the dialog | 679 px, fits the 759 px body |
| Phone sheet 390×844, list height | 844 px, 86 px hidden | 718 px, fits the 804 px body |
| Dialog body overflow | 127 px desktop, 126 px phone | 0 |
| Search box after scrolling | pushed out of view (−111 / −110 px) | stays in place (16 px) |
| Last row visible after scrolling the list to its end | no | yes |

- The class-lock test is real. With the fix, `ModelBar.test.tsx` passes (26 tests). With the wrapper put back to the old classes, the new case fails: `min-h-0: expected false to be true`.

**M1 (marker test without PI_OFFLINE): real.**
- `available.marker.no-command-online` passes with no `PI_OFFLINE` set (3 of 3 in the file).
- I made the op open Pi's own credential store instead of pap's, and the test failed because the auth marker file was created.
- Nit, not blocking: the test switches the offline flag off with `vi.unstubAllEnvs()`. If the parent shell already has `PI_OFFLINE` set, that call puts it back and the test quietly runs offline. One line such as `expect(process.env.PI_OFFLINE).toBeUndefined()` would close that gap.

**M6, M2, M3 (docs): accurate.**
- **M6:** ADR 0068 now names the model-service writes that clear the cache and says MCP and trust writes don't.
- **M2:** the lane bullet in `models.md` points to the "Trust inheritance" rule in `lanes.md` and matches it.
- **M3:** the damaged-file bullet matches how Pi behaves: a warm worker keeps its last good settings, while the helper falls back to the full signed-in list. A corrupt `models.json` makes both drop the custom providers.
- Nit, not blocking: the cache bullet in `docs/agents/models.md` (line 59) still opens with "when each write of Pi's files settles", though it then lists the paths and the exceptions.

**Before the merge, as in my first report:**
- Squash-merge, as A0 was, or `git rebase --onto main 7380bea9`.
- The only textual conflict with M12 is in `apps/web/src/i18n/index.ts`: keep both sides.
- After the rebase, re-run the full gate and C2 scene 2.

The scratch copy is deleted, no container is left running, and the worktree is untouched. The probe and its results are in `/tmp/claude-1000/-home-ubuntu-Workspace-soulkyu-pi-agentic-platform/5131dd4e-de2d-4935-a5a9-3de6a37da440/scratchpad/final-a-probe/` (`probe2.mjs`, `result-80f06f7d.json`); the test runs are in `/tmp/claude-1000/-home-ubuntu-Workspace-soulkyu-pi-agentic-platform/5131dd4e-de2d-4935-a5a9-3de6a37da440/scratchpad/final-a-fix-tests.log`.
