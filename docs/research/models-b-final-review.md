# Models batch, chain B: final review (Opus) and browser check

Whole-branch review of chain B (8f75402b..6032e434 on feat/models-b-web), its scoped re-review after the fix (273e9853..3eed970d), then the end-to-end browser check of task 15 step 3 on a temporary instance (ruling MPR-C11) and the fix of its two UI defects (760be237, controller mutation check). Chain B merged as 327aaa6 (decision 98).

**Merge recommendation: Ready after fixes.** Two Important issues, both small to fix. No Critical. Read-only review of `8f75402b..6032e434`; the gate was run once in a scratch copy, which is now deleted. The worktree is clean at 6032e434.

#### Spec Compliance
- ❌ Issues found: I1 and I2 below. Everything else matches the brief and the rulings MPR8–MPR29 and MPR-C1–C10.
- ⚠️ Cannot verify from the diff:
  - That each task's tests were seen failing first and that its mutation checks ran (task reports, already checked by the task reviewers).
  - Real-browser behaviour of the form and the availability view: only jsdom covers them. T15 step 3 (by hand on the preview) is still the controller's step after the merge.

**The owner's flow, walked through the code.**
1. **Add**: "Add a provider" → `models.provider.get {}` → preset → form → Save (password step-up). The helper checks the revision, merges, runs Pi's loader on a private copy, writes the file atomically (0600), then resyncs `enabledModels`. The daemon clears the cache and audits the provider id only.
2. **Key**: the form shows `KeyOffer` → `ApiKeyForm` → `models.setApiKey` → `auth.json`.
3. **Import**: discover → tick → save again.
4. **Offer**: the availability view switches → `models.setEnabled` → the preview re-reads `models.available`.
5. **Pick**: a warm worker reloads before it lists (`freshAvailable`), so the session menu sees the provider.
6. **Remove**: `alsoRemoveKey` removes the entry, then logs out, in one queue slot.

The flow works except for I1 and I2. The one other awkward step is Minor M1.

#### Lessons checklist
| Item | ✅/❌/n/a | Evidence |
|---|---|---|
| Bounded resources, cap crossed | ✅ | Caps: `base-url.ts:1`, `provider-apply.ts:52` (300 providers), `DiscoverImport.tsx:43-45` + `DiscoverImport.test.tsx:41`, `models-extensions.ts:50-95`. One read in flight: `use-availability.ts:30-74`, `extensions.ts:8-19` |
| Errors never silent | ✅ | `use-provider-save.ts:109`, `ExtensionProviders.tsx:52-60`, `use-availability.ts:55-61`, `models-json-shared.ts:76` |
| Deadlines, timers | ✅ | `provider-config.ts:14-15` (30 s), `service.ts:49` (60 s); no new timers |
| Fail closed | ✅ | `provider-view.ts:41-72`, op-level header guard `provider-apply.ts:83-99`, `models-extensions.ts:43`, `parseStrict` |
| Untrusted text | ✅ (M6) | `auditId` `provider-config.ts:35-50`; `stripHidden` in `availability.vm.ts:39-90`, `DiscoverImport.tsx:69`, `RemoveProvider.tsx:90`, `ProviderFormPanel.tsx:50` |
| Auth / owner on new paths | ✅ | `pi:admin` at `models-provider-form.ts:197-216` and `models-extensions.ts:38`; step-up at `provider-config.ts:83,101`; `pi-token.test.ts` rows |
| Stale answers dropped | ✅ | `use-provider-form.ts:59-66`, `use-provider-save.ts:65-66`, `use-availability.ts:46-49`, `ExtensionProviders.tsx:33-50` |
| No await in check-then-act | ✅ | step-up checked before the queue; revision re-checked right before the write (`models-json-shared.ts:179`) |
| Mutations `idempotent:false` + commandId | ✅ | `methods-idempotent.ts` (+3 lines); the target is bound through `sensitiveParams` |
| Keys unique by construction | ✅ | `${index}:${id}` in `ProviderRows.tsx:141`, `Preview.tsx:82,89`, `ExtensionProviders.tsx:104,123` |
| Tests RED / mutation checks | ⚠️ | Per task reports. Gaps: no test of a remove with the key box ticked and no key stored (I2), none of key precedence (I1) |
| Exact assertions, no sleeps, hygiene | ✅ | `provider-config.int.test.ts` `toEqual({[AUTH]:1})`, temp root removed in `afterEach`, network guard; no sleep in any new test |
| Repo rules, honest copy | ❌ | Largest file 334 lines, no AI trailer, all subjects conventional. Copy claims more than the code does (I1) |

#### Strengths
- **Trust boundary holds across tasks.**
  - Keys:
    - The form never holds a key.
    - The provider methods' receipts hash only `id`, `mode`, `baseRevision` (and `alsoRemoveKey` for remove).
    - Helper results are parsed with a strict schema.
    - The pool logs no output tail for these ops (`skills.install` is the only op whose tail is logged).
    - The int test walks the whole temp root: the marker key is found once, in `auth.json`.
  - No `!command`: the form never writes one (env name pattern; literal header refuses `!` and `$`), and none runs on a read.
- **Header masking** (MPR-C3 and MPR-C4): every literal header value comes back as `keep` (`provider-view.ts:52`). A kept header's name is locked (`HeaderRows.tsx:40`). A kept value with no match in the file is refused at op level (`provider-apply.ts:95-99`).
- **Credential-word gaps: deferring is safe.** A header named `X-Pass` or `JWT` can be stored as a literal in `models.json` instead of being forced to an env reference. Nothing leaves pap:
  - The raw editor masks every value under `headers`, whatever the name (`models-json-mask.ts:17`).
  - `get` returns every literal header as `keep`.
  - No log, audit row or receipt carries it.
  - What remains is a secret at rest in a 0600 file left out of M6b backups, the same as typing it in the raw editor today. The raw-editor limits are documented honestly (`models.md:38-39,117`).
- **Pi file writes**: one queue, the field-preserving merge, the revision checked twice, and the cache cleared after every write (`provider-config.ts:69-75`, plus `serialised`).
- **Extension isolation unchanged since T13's review.** `extension-load.ts`, `offline.ts` and `auth-store.ts` are byte-identical between 78c4d0d1 and 6032e434; `models-extensions.ts` differs only by T15's one-line `modelsTruncated` carry. The UI shows `truncated` and `modelsTruncated` and claims no offline load (`settings-availability.ts:54`).
- **Rebase-point merge 83ffe357 lost nothing.**
  - Against A's tip: no A line is missing from the 27 files both chains touched (the A-only files are identical to A). The few `-` lines are B's own test ternaries, extended.
  - Against B's tip: the dropped lines are only B's old picker code replaced by A's front lanes, plus four comment or catalog lines where A's wording won.
- **i18n**: French in the vous form, a space before `:`, accent and lazy-catalog tests present.

#### Issues
##### Critical (Must Fix)
None.

##### Important (Should Fix)
1. **I1. A stored key silently overrides the form's "Environment variable" and "No key".** Pi uses a stored `auth.json` credential before the `models.json` `apiKey`. Probe against Pi 1.1.0: `getAuth` returned `source: "stored credential"` with `apiKey` set to `"$FOO_PROBE"`, to `"local-no-key"`, and with no `apiKey`.
   - **Edit case**: switching stored → env or none deletes nothing from `auth.json` (`provider-apply.ts:63-75`). Pi keeps sending the old key, yet the copy says "The daemon reads this variable…" and "No key is needed…" (`settings-providers.ts:53,57` and the French strings). MPR22: copy claims more than the code does.
   - **Re-create case**: a remove with the box unticked (the default, `RemoveProvider.tsx:38`) leaves an invisible key. The overview lists only providers Pi knows (`models-overview.ts:70`), so no UI path clears it. Creating a provider with the same id later, with any base URL and any auth kind, sends that old key to the new host. The step-up stops an attacker, not the owner's surprise.
   - **Fix**:
     - In `AuthFields`, when the provider has a stored key (`ProviderView.auth.stored !== null`) and env or none is chosen, say so and point to Sign out (or offer the removal in the same queue slot).
     - Have `get`/`save` tell the UI that `auth.json` already holds a credential for a new id (the helper can read its store without resolving anything).
     - State the precedence in ADR 0069 "Keys" and in `models.md`.
2. **I2. Remove with "Also remove the stored key" ticked answers `not_found` when no key is stored.** By then the entry is already gone. Int probe with the real helper pool (save `auth: none` → remove with the box ticked):
   - The call answers `{ok:false, error:{code:"not_found"}}`, yet `models.json` is `{"providers":{}}` and the audit holds `[provider_saved, provider_removed]`.
   - The UI then shows the orphan-key offer, and its "Remove the stored key" also fails `not_found`.
   - Cause: `provider-config.ts:113-116` runs `auth.logout` after the removal, and `auth.ts:181-182` throws when neither the runtime nor the store knows the id.
   - This hits every keyless provider: the Ollama, LM Studio and vLLM presets, env providers, and stored providers whose key was skipped.
   - **Fix**: treat a `not_found` from the logout step as "no key", with no `provider_signed_out` audit, or read the store first. Optionally show the box only when a key is stored. Add the case to `provider-config.int.test.ts` and to `smoke-models.ts` (remove `smoke-local` with the box ticked).

##### Minor (Nice to Have)
- **M1.** In the add form, Discover is disabled with "Save the provider first", but every first save closes the form (`use-provider-save.ts:93-94`, `ProviderFormPanel.tsx:115-118`). Importing always needs Edit. Either keep the form open after a create, or reword the hint.
- **M2.** `provider-rpc.ts:6-26` still casts the RPC client with hand-typed params and a stale "lands with Task 10" comment. This is a dropped T11 carry: the methods are now in `MethodName`.
- **M3.** A create whose id is already in the file but missing from the overview answers `conflict` (`provider-apply.ts:50`). The UI reloads `get {}` and the retry loops. Map it to `config_invalid ["$.provider.id"]`.
- **M4.** The key offer appears after every stored save, edits included (`use-provider-save.ts:93`).
- **M5.** In "My selection" mode a new provider is saved but not offered: the resync only covers providers that were fully enabled before the write (`models-json-shared.ts:117-132`). Nothing says so after the save.
- **M6.** `ProviderList.tsx:45` renders `provider.name` without `stripHidden`. The line predates this batch, but the file is edited here and the aria-label beside it strips.
- **M7.** Doc and copy details:
  - `models.md:8`: the step-up list omits provider save and remove.
  - `models.md:59`: the cache-clear list omits them (line 70 states it).
  - `settingsProviders.models.none`: the French text has an extra clause the English lacks.
  - The "Kept as is" auth option disappears once the owner switches away; Cancel is the only way back.
  - Known follow-ups: plural forms, audit ids for `setApiKey`/`logout`.

#### Merge readiness
- **Gate on 6032e434, scratch copy, one run, all green.**
  - Checks: lint, format:check, typecheck, knip.
  - Unit: 1523 files, 18 108 passed, 2 skipped.
  - Int (clean env, `CI=1`): 221 files, 1300 passed, 2 skipped, no flake.
  - Build, budgets: 229.3 KB gzip.
  - Smoke: ok, including provider get/save and the available list.
- **How to merge.** Do not replay B's 21 commits: they contain A's cherry-picks (34ffdcb8, e3544035, a03b1a5a, 65ab4bbe) and the two merge commits. Instead:
  1. Merge A's final fix 80f06f7d into B (clean in a trial: 5 files).
  2. Squash the diff from 80f06f7d to that merge onto main once A's squash is there.
- **Trial of that squash** on main + M12 join (1ccb72e4) + A squash + M6b (7b2d7ac2, 373944a4, 65ef029b): it applied cleanly.
  - Typecheck green; unit 1686 files, 20 262 passed, 3 skipped; build green; bundle 232.9 KB.
  - Lint red only in M12's own push files at 1ccb72e4 (`compose-push*.test.ts`, `daemon.push.*.int.test.ts`); B does not touch them.
  - Int and smoke were not run on this stack.
- **Likely conflicts.**
  - B with M12: four files, all clean in the trial — `apps/web/src/i18n/index.ts` (watch the `MessageKey` union's closing `;`), `contracts/src/index.ts`, `methods-idempotent.ts`, `methods.test.ts` (381 lines in the trial, limit 395).
  - B with M12's app shell or Settings screen: none (B edits only `features/models/*`).
  - B with M6b: none (B does not touch the daemon CLI).
  - A with M12, at A's own merge: `i18n/index.ts`, `utilities.css`, `Gallery.test.tsx` (`PROBED_CONTROLS` is 80 on M12 and 81 on A; 81 passed in the emulated stack), `decisions-log.md` (rows 93/94).
- **Re-check after the rebase.**
  - The full gate, including int and smoke.
  - The exhaustive `METHOD_IDEMPOTENT` table with M12's `push.*` names.
  - `catalog-keys.test.ts`, `compose-pi.test.ts` and the bundle number.
  - M12's service worker with the stale-chunk message for the `provider-*` and `AvailabilitySection-*` chunks.
  - `AGENTS.md` (58 of 150 lines) and B's decision-log row.
  - T15 step 3 by hand, including the I1 and I2 flows.

#### Assessment
**Task quality:** Needs fixes
**Reasoning:** The trust boundary, write path, extension isolation and the rebase-point merge all hold, and the gate is green. Two cross-task gaps remain: a stored key overrides env/none without a word, and a keyless removal with the key box ticked reports a failed removal that actually worked. Both are small fixes plus one int case and one smoke step each.

**Merge recommendation: Ready after fixes** — fix I1 (copy + stored-key notice + docs) and I2 (logout `not_found` treated as "no key", int + smoke case); Minors can follow.

## Re-review

Final B re-review (Opus) — READY: I1 (keyStored boolean + ids only, strict, damaged auth.json → no ids; edit/add warnings; Pi 1.1.0 precedence re-probed, copy matches en/fr) and I2 (not_found = no key; real-pool int fails with the old throw; smoke step) proven; M1–M3, M6, M7 done.

## Task 15 step 3, browser check

### T15 step 3 report (models batch B, Chromium, temp instance)

Harness: <scratchpad>/pw/shots-t15/../t15.sh and t15.mjs. Screenshots and t15.json: <scratchpad>/pw/shots-t15/. Final run: all 6 flows PASS, daemon error log lines 0, browser console errors 0.

1. PASS add provider via form (OpenAI-compatible preset, stub http://127.0.0.1:<port>/v1, 2 models, stored key): saved, "Provider saved. Add the key." shown. Evidence 01-form-filled.png, 01-saved.png.
2. PASS key marker (pap-t15-marker-<12 hex>) found as bytes only in pi/auth.json; absent from the whole temp PAP_HOME tree, daemon stdout log and models.json. Evidence 02-after-keysave.png, t15.json.
3. PASS agent form picker lists stub-alpha, stub-beta (stored key) and open-one (auth "No key" provider). Evidence 03-agent-picker.png.
4. PASS "My selection" mode, stub-beta switched off: settings.json gets no stub-beta entry, picker offers stub-alpha and open-one only. Evidence 04-selection-mode.png, 04-beta-off.png, 04-after-reload.png, 04-agent-picker-after-off.png.
5. PASS I1: with a stored key, switching to "No key" and to "Environment variable" both show the copy "A key is already stored for this provider, and Pi uses it before this choice. Sign out of the provider on its page to remove it." Evidence 05-warn-none.png, 05-warn-env.png.
6. PASS I2: removed the auth-none provider with "Also remove the stored key" ticked and no key stored: no alert, gone from models.json and from the UI after reload. Evidence 06-remove-ask.png, 06-after-reload.png. Extra: an earlier run removed a provider WITH a stored key and the box ticked: key gone from auth.json, provider gone (no error).

#### Defects
- D1 (medium) After "Save key" in the post-save key form, the provider page keeps saying "Not signed in" and the availability chip "not connected" for more than 4 s, until a page reload (the key is stored: the picker preview already lists the models). Repro: add stored-key provider, save, type key, Save key, look at the provider page. Cause: KeyOffer onDone leads to onFinished (close + select) without onChanged. Evidence 02-after-keysave.png.
- D2 (minor) A model switch in the availability view takes about 4 s to flip after the click (count line "1/2 offered" updates first and the switch stays on, so the row contradicts its own count meanwhile). Evidence 04-beta-off.png (taken 3.5 s in, earlier run).
- D3 (minor) The provider list and the Add/Edit form sit below the availability view and the extensions block, at the bottom of a very long page; opening Add or Edit, and the save step, do not scroll or move focus to the form (a user must scroll down). Evidence 00-models-settings.png, 05-warn-none.png.
- D4 (note, copy) Cancel on an edit form where only the auth source was changed asks "Discard your unsaved changes to models.json?", the question shows far below the fields. Evidence 05-discard-ask.png.
- After removing a provider, a "My selection" entry for it shows "No model matches ..." until Clean up: expected.

#### Cleanup
Container pap-t15-pw, Vite (5173), daemon, stub server, temp PAP_HOME and Pi dir removed by the harness trap; port 5173 free; no tracked file modified. WebKit not run.


## Fix of the browser-check defects

### T15 fix report (D1, D3)

- D1: `KeyOffer` got `onStored`; `ProviderForm` got `onKeyStored(id)`; `ProviderFormPanel` wires it to `onChanged` (the overview reload used after other writes). Skip/cancel do not reload.
- D3: `ProviderForm` scrolls its section into view (`scrollIntoView`, optional call) and focuses the first field when a step opens (preset, form) and the key field when the key offer appears.
- Tests: `apps/web/src/features/models/provider/ProviderForm.focus.test.tsx` (2 tests); spy `keyStored` added to `provider-models-bed.tsx`.
- RED (fix reverted, tests kept): both fail. "expected vi.fn() to be called at least once" (no scroll); "expected <body> to be <input ...>" (no focus on key field). GREEN after the fix.
- Gate (lint, format:check, typecheck, knip, unit vitest, build, budgets): all pass.
- Not touched: D2, D4.
