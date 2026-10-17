# pap models batch: one picker fed by Pi's model list, providers and availability from Settings - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status (2026-10-17):** fixed from the Opus red-team (`.superpowers/redteam-models.md`: 0 Critical, 8 Important, 15 Minor) and the owner's answers (`.superpowers/owner-decisions-2026-10-17-models.md`: every recommendation; the question page is archived as `docs/design/questions/2026-10-17-models.html` and `-answers.json`). Ready for SDD execution. Decision 94 (`docs/research/decisions-log.md`). Ledgers at the end: "Owner answers (2026-10-17)", "Red-team ledger", "Deferred minors". 16 tasks (task 5 is split into 5a and 5b).

**Goal:** (A) every place that picks a model offers exactly the models Pi would let that context use, through one shared searchable picker, and every long `Select` scrolls; (B) Settings > Models gets a provider form (add, edit, remove) and an "Available models" view that controls and previews what every picker offers; (C) designed, not built: a pap-side allow-list per person, project or agent.

**Architecture:**
- **One function, two callers.** `listAvailable` in `packages/pi-host/src/available-models.ts` is the worker's current inline `listedModels`, extracted. The worker calls it for a session (`sessions.models`, `set_model`) after re-reading settings and `models.json` (`freshAvailable`, MPR25); a new helper op `models.available` calls it for contexts without a session. A daemon method `models.available { cwd? }` (`pi:read`) fronts the op with a short, generation-guarded, single-flight cache.
- **One picker.** `features/models/picker/` (field + list + vm + hook) replaces every model `Select`; the field is eager and tiny, the list is lazy through the repo's `useRetryableLazy` and `LazyBoundary`. The popover is the owner's choice (owner q1). The session menu keeps its dialog, stars and `sessions.setModel`; its list becomes the shared list.
- **Provider form writes `models.json` through helper ops** (`models.provider.get|save|remove`), browser-only with the password step-up on writes, strict-JSON merge that keeps every field the form does not own, Pi's own loader as the validator, keys only through the existing `ApiKeyForm` and `models.setApiKey` (the form holds no key). A provider outside the form's grammar is `editable: false`, never an error.
- **Availability view** writes only through the existing `models.setEnabled` and previews with `models.available`.
- **Lanes (see "The lane graph").** A0 (task 4, the `Select` fix) merges first and alone. Chain A's daemon half (1, 2, 3) and web half (4, 5a, 5b, 6) run in parallel and join at task 7. Chain B (8 to 13) runs beside A in two halves and rebases once before task 14. Merge order across the three plans: A0, M12, models A, M6b, models B.

**Tech Stack:** Node 24, TypeScript (erasable syntax), zod 4.6.5, Pi SDK 1.1.0 (`@earendil-works/pi-coding-agent`, `pi-ai`), React 19 + Radix (`radix-ui`, already a dependency: Popover, Select), Vite 8, vitest. **No new dependency.**

**Spec:** `docs/specs/2026-10-17-models-picker-providers-design.md`. Binding context: `docs/agents/models.md`, `docs/research/m7-rulings.md` and `m7-rulings-after-join.md` (M7R41, R45, R46, R47, R54 to R56, R65, R66, R133; MC24, MC25, MC28 to MC34, MC52), ADRs 0023, 0026, 0029, `DESIGN.md`, boards `docs/design/explorations/08-settings-appearance.html`, `05-shell-mix-ac.html`, `12-mobile-system.html`, and the archived owner page `docs/design/questions/2026-10-17-models.html` (the CHOSEN options: q1 popover, q2 presets, q3 mode first).

**References read (read-only, untrusted):** T3 Code `apps/web/src/components/chat/modelPickerSearch.ts` (token scoring: exact, prefix, boundary, substring, fuzzy at 3+ characters; favourites boosted) and `ModelPickerContent.tsx` (search-first list, one row per model) are the model for task 5a's ranking; they are re-written, not copied. pi-web's model settings (`docs/research/pi-web-inventory.md` D07 to D10) is the parity baseline already green. Orca has no model picker worth borrowing. Pi docs read: `docs/models.md`, `docs/providers.md`, `docs/configuration.md`, `dist/core/model-config.d.ts`, `dist/core/model-runtime.js` (`getAvailable` runs `checkAuth` for each provider; `refresh` re-reads `models.json`), `dist/core/settings-manager.js` (caches `enabledModels` until `reload`), `pi-ai` `KnownApi`. Pi facts verified by running it in a scratch agent dir (2026-10-17, plan fix): a warm `ModelRuntime` does not see an edited `models.json` until `refresh({ allowNetwork: false })` and a warm `SettingsManager` does not see an edited `settings.json` until `reload()`; Pi accepts `//` line comments and trailing commas in `models.json` (not block comments); Pi loads a provider whose `api` is unknown.

## Global Constraints

- 400 lines per file at most, test files included, no baseline. Sizes today that matter: `apps/daemon/src/modules/models/service.ts` 259, `packages/contracts/src/models-methods.ts` 357, `packages/contracts/src/methods.ts` 386, `packages/contracts/src/methods.test.ts` 376, `packages/pi-host/src/helper/ops/models-json.ts` 284, `models-json.test.ts` 400, `apps/web/src/i18n/catalog/settings-models.ts` 306. Grow none of them past 395: new code goes into new files composed in by a few lines. `methods.test.ts`: if this batch's names would take it past 395, they go into a new `models-methods-names.test.ts`; the second of the three plans to merge recounts.
- A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`. Every RPC method declares a permission. RPC handlers decode, call one service method, map typed errors.
- TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep `.ts`. Tests never touch `~/.pi/agent` or `~/.pap` (a temporary agent dir from `makeModelsBed`, `packages/pi-host/src/testing/models-bed.ts`), never use the network (`testing/network-guard.ts`: `blockedAttempts` is an exported array, read it as `blockedAttempts` or `blockedAttempts.length`, never as a call), never sleep; timers go through the kernel `Clock`.
- UI: tokens from `packages/ui/src/tokens.css` only (the spacing token is `--spacing-s2`, `--space-2` underneath); no raw colours, no `[...]` arbitrary values, no restyling of `@pap/ui` primitives. Everything visual stays customisable in Settings (owner rule). The only ESLint directive is `eslint-disable-next-line <rule> -- <reason>`. Every UI task compares its render with the CHOSEN option of the archived owner page and the boards named in the spec line above (decision 80) and says so in its commit body.
- Lazy parts use `apps/web/src/lib/lazy.tsx` (`useRetryableLazy`, `LazyBoundary`, `isStaleChunk`, `notifyLazyFailure`), never a bare `React.lazy`. A stale chunk or an `unknown_method` answer (an old shell calling a new daemon, M6b `pap update`, M12's service worker) shows the "reload the page" message, never a raw error.
- Pi's configuration (`auth.json`, `models.json`, `settings.json`) is read and written only in a helper (ADR 0023). A helper read never installs anything and never runs a `!command` (MC25, MC52). Every write of Pi's files goes through the daemon's one Pi write queue (MC28, MC29).
- `models.json` writes, keys and `enabledModels` stay browser-only (`pi:admin`; a token is `forbidden`). A token-readable result (`models.available`) carries no key, no header value and no path.
- Keys never reach a log, a response, an audit detail, a receipt or `/metrics`. Methods carrying them list `sensitiveParams`. The provider form holds no key at all (MPR12).
- Text that is not pap's own (model names, provider names from `models.json`, discovery or an extension) is rendered through the control-stripper `stripHidden` (`features/agents/untrusted-text.ts`) and as React text (MPR26).
- Caps refuse when full and never evict (provider count, models per provider, headers). Every new client store is reset at sign-out (MC34); this batch adds none (task 5a pins it).
- French copy uses vous and carries its accents (each new catalog has a test asserting that a fixed word list appears accented: modèle, réglages, fournisseur, clé, enregistré, proposé); per-feature lazy catalogs `en` and `fr`, each with a `MessageKey` line in `apps/web/src/i18n/index.ts`, an entry in `catalog-keys.test.ts` and a `lazy-catalog.*.test`; no literal bidi, zero-width or line-separator characters in source or in this plan (numeric code points only).
- Initial bundle: 227.4 KB gzip today, 300 KB CI ceiling until M13. Eager additions of this batch: at most +1.5 KB gzip in total (per task below); the picker list, the form and the availability view are lazy.
- Conventional Commits; rebase on the target branch before a PR; no AI trailer, no Co-Authored-By.

## Review Focus

Failure modes the spec implies that no task's main test would exercise; each is pinned by a named test in the owning task.
1. **A hand-written `!command` key anywhere (auth.json, models.json) must never run when a picker opens:** task 2, `available.marker.no-command` (marker file stays absent for both files). The worker's own default store does run one (MC25, MPR1): the picker footnote says so.
2. **A stored credential that is an expired OAuth token must not make the picker call the network or block it:** task 2, `available.oauth-expired.no-network`.
3. **`enabledModels` patterns that match only unsigned providers must fall back to the signed-in list (never an empty picker):** task 1, `scope-matches-nothing-falls-back`.
4. **Editing a provider that carries fields the form does not own (`compat`, `modelOverrides`, a model's `cost`) must keep them byte for byte:** task 9, `save.keeps-unknown-fields`.
5. **A `models.json` with comments, a trailing comma or a 17-digit integer must be refused by the form, not rewritten:** task 9, `save.refuses-comments`, `save.refuses-long-integer`; the provider shows as `editable: false` with the raw-editor pointer (task 9 `get.comments-file`, task 12).
6. **A saved agent or lane model that is no longer offered stays visible as "saved, no longer offered" and is not silently replaced:** task 6, `saved-model-stays-visible`.
7. **No key lives in the provider form:** the key is typed only in the existing `ApiKeyForm`, which empties itself; tasks 11 and 12 pin that the form has no password input and that a marker key appears nowhere around a save (`key.marker.nowhere`); task 10 pins the server side.
8. **A picker opened with 2000 models and a 360 px screen stays scrollable and operable by keyboard and touch, also inside a modal Dialog:** jsdom guards in tasks 4 and 5b; the real proof is the controller steps C1 and C2 (blocking, MPR27).
9. **A warm worker sees what the owner just changed (MP-RT-01):** task 1 `worker.warm-sees-new-provider`, `worker.warm-sees-new-enabled-models`; task 3 int `sessions.models and the helper agree after a write`.
10. **A provider outside the form's grammar (LAN `http:` URL, query URL, uppercase id, odd header name, unknown input kind) opens as `editable: false` and can still be removed (MP-RT-02):** task 9 `get.degrades.*`, `remove.any-id`.
11. **A replay of a provider save with the same command id but another target is refused (MP-RT-03):** task 10 `save.replay-other-target`.
12. **A read that started before a write never repopulates the cache (MP-RT-06):** task 3 `cache.write-during-read`, `cache.single-flight`.

## Conflict scan

**Between tasks of this plan** (halves are disjoint except where named):

| Shared file or interface | Tasks | Resolution |
|---|---|---|
| `packages/contracts/src/models-methods.ts` | 2 (one spread + import), 8 (one spread + import), 13 (one spread) | Whole-line additions in the `modelsMethods` object; each task creates its own contracts file (`models-available.ts`, `models-provider-form.ts`, `models-extensions.ts`). A and B touch different lines. |
| `packages/contracts/src/pi-helper.ts` (`HELPER_OPS`) | 2, 8, 13 | Whole lines added at the end of the models block. |
| `packages/pi-host/src/helper/ops.ts` | 2, 9, 13 | One import and one registry line each. |
| `apps/daemon/src/modules/models/{service.ts,rpc.ts,index.ts}` | 3, 10, 13 | `service.ts` gets a composed factory per task (`available.ts`, `provider-config.ts`, `extensions.ts`), at most 8 lines each; `rpc.ts` one `Pick` entry and one handler line each. |
| `packages/contracts/src/audit.ts` (reasons) and `models-login.test.ts` (the reason list) | 10 | One task. |
| `docs/agents/models.md` | 7 (picker, source), 15 (form, availability, extensions) | Sequential: 15 starts after the rebase; sections are separate headings. |
| `apps/web/src/i18n/{index.ts,catalog/,catalog-keys.test.ts}` | 5a, 5b, 11, 12, 14 | One new lazy catalog file per feature (`model-picker.ts`, `settings-providers.ts`, `settings-availability.ts`, each with its `register-*.ts`); `settings-models.ts` (306) is not touched. `index.ts` gets one `MessageKey` line per catalog and `catalog-keys.test.ts` one entry (whole lines, alphabetical). |
| `apps/web/src/features/models/ModelsSection.tsx` (214) | 11 (mount the form), 14 (mount the availability section) | After the rebase point; each adds at most 6 lines. |
| `packages/ui/src/index.ts`, `utilities.css` | 4 (`max-h-available`, viewport rule), 5a (Popover export, `max-h-popover`) | A0 and A-front, in that order (4 merges first). |
| `apps/web/src/gallery/sections/FormFigures.tsx` | 4 (Select figure), 5b (picker-in-dialog figure) | Different figures; 5b rebases on A0. |
| `scripts/smoke-models.ts` (new), `scripts/smoke-dist.ts` | 7 | One new file plus one import line and one call line in `smoke-dist.ts` (239 lines). |

**With M12 and M6b** (both planned, not started; additive whole-line edits only; the agreements are in `.superpowers/m12-m6b-cross-plan-agreements.md`):

| File or interface | This batch | M12 | M6b | Rule |
|---|---|---|---|---|
| `packages/contracts/src/{methods.test.ts,index.ts}` | adds method names and exports | adds `push.*` (7 names) | none | alphabetic insertion of whole lines; `methods.ts` itself is not edited (new methods ride `modelsMethods`; M12's task 1 is its only editor) |
| `packages/contracts/src/{permissions.ts,errors.ts,methods-idempotent.ts}` | `models.available`, `models.provider.get`, `models.extensions` into `methods-idempotent.ts`; no new error code | adds lines | none | whole lines |
| `apps/daemon/src/daemon.ts`, `compose*.ts` | none (`compose-pi.ts` already builds the models module; `compose-pi.test.ts` method list gets the new names) | `compose-push.ts` | none | `compose-pi.test.ts` list: whole lines |
| `apps/web/src/i18n/{index.ts,catalog/*,catalog-keys.test.ts}` | three catalogs and their `MessageKey` lines | `notifications`, `landing`, `pwa` catalogs and lines | none | each plan adds `MessageKey` lines alphabetically; the second to merge re-sorts. M12's table must name `i18n/index.ts` too (controller note in the report). |
| `budgets.json`, `build-output.int.test.ts` | no change expected (tasks 5b and 15 read the numbers) | adds an SW line | may add lines | untouched here |
| `AGENTS.md` (150 lines at most) | tasks 7 and 15 add 2 lines in total | adds 3 | adds lines | the second to merge re-counts |
| `docs/agents/models.md`, `docs/agents/web.md` | edits | `web.md`: one SW paragraph | none | different paragraphs |
| ADR numbers | 0068 to 0070 | 0058 to 0062 | 0063 to 0067 | disjoint |
| Migrations | none | one | none | n/a |
| Decisions log | decision 94 (this plan fix) | 93 | none | |
| `packages/ui` (`Select.tsx`, new `Popover.tsx`, `utilities.css`) | owns them | task 19 and the mobile fills only use them; a utility class M12 needs goes after this batch's block in `utilities.css` | none | M12 must not edit `Select.tsx` |
| Backup and restore (M6b) | `docs/agents/models.md` says providers, selection and keys are not restored (MPR29) | none | the restore summary says the same (M6b Q2 note, controller) | MP-RT-23 |
| Updates and the service worker (M6b, M12) | the picker treats `unknown_method` and a stale chunk as "reload" | the SW update banner | none | one message key shared with M12's reload wording |

**Owned by this batch** (nobody else edits): `apps/web/src/features/models/*`, `features/sessions/{ModelMenu,ModelBar,model-menu.vm}`, `features/agents/{ModelFields,use-agent-models,model-fields.vm}`, `features/lanes/{ModelSlots,new-lane.vm,use-new-lane-data}`, `packages/ui/src/primitives/Select.tsx`, the daemon `models` module, the pi-host model helper ops.

## The lane graph

```
 A0   (merges first, alone)
 4  Select bounded + scrolls ---> C1 controller proof (blocking) ==> MERGE A0

 A-back (daemon half, serial)                     A-front (web half, serial, branch a-front)
 1  listAvailable + freshAvailable (worker)       4  (A0 above, then the rest of the half follows it)
 2  models.available contract + helper op  O      5a Popover, vm, hook, catalog, scan test
 3  daemon method, cache, wiring           O      5b list, field, session menu, figure   (needs 2's contract commit)
                                                  6  agent form + new lane use the picker
                \                                   /
                 7  JOIN: docs, ADR 0068, smoke-models, A full gate, C2 controller proof ==> MERGE A (after M12)

 B-daemon (serial, from t=0)                      B-web (serial, starts when task 8 lands)
 8  form contracts + URL check            O       11 provider form UI (presets, validation)
 9  helper ops get|save|remove            O       12 form flows (save, key via ApiKeyForm, discover, remove)
 10 daemon methods, step-up, audit        O
 13 extension providers                   O
                \                                   /
                 REBASE POINT (controller, once: after M12, A and M6b have merged; mechanical)
                 14 availability view + extension list --> 15 docs, ADRs 0069/0070, smoke-models cases, B full gate ==> MERGE B
```
`O` = Opus reviewer (reason in the model table).

- **Merge order across the three plans:** A0, then M12, then models A, then M6b, then models B. A0 touches only `packages/ui` and a gallery figure, so it merges as soon as C1 passes. A waits for M12 and rebases on it once (whole-line shared files). B rebases on `main` once after M6b (and A) have merged; if M6b is late, B rebases after A, then once more, mechanically.
- **Join.** Task 7 is the only join of chain A. A-front depends on A-back for one thing: the `models.available` contract (task 2). When task 2 passes review the controller merges A-back's commits 1 and 2 into `a-front` before dispatching 5b; 5a (and 4, 6's fakes) need nothing else. B has no join task: B-daemon and B-web touch disjoint files and are combined by the controller at the rebase point.
- **Gate slots** (two heavy slots shared with M12's three chains and M6b's two or three): gate tiers (owner-approved). Web-only tasks (4, 5a, 5b, 6, 11, 12, 14) run unit + build + budgets and never take a heavy slot. `test:int` runs only for runtime tasks (2, 3, 9, 10, 13). The two full gates (tasks 7 and 15, about 45 minutes each) are the only long slot holds: never run one while a full gate of M12 or M6b runs, and never both slots at once.
- **ETA** (1.25 h per Sonnet-reviewed task with its review, 1.5 h when the reviewer is Opus):

| Chain | Tasks | Work | Ready at |
|---|---|---|---|
| A0 | 4, C1 | 1.25 h + 0.25 h | **1.5 h** (merge A0) |
| A-back | 1, 2, 3 | 1.25 + 1.5 + 1.5 | 4.25 h |
| A-front | 4, 5a, 5b, 6 | 1.25 + 1.25 + 1.25 (5b starts at 2.75 h, after task 2) + 1.25 | 5.25 h |
| A join | 7 + gate + C2 | 1.25 + 0.75 + 0.25 | **7.5 h** (A ready; merges after M12) |
| B-daemon | 8, 9, 10, 13 | 1.5 x 4 | 6.0 h |
| B-web | 11, 12 (from 1.5 h) | 1.25 x 2 | 4.0 h |
| B tail | rebase, 14, 15 + gate | 0.25 + 1.25 + 1.25 + 0.75 | **11.0 h** |

- **Critical path:** A-front (5.25 h) -> join (2.25 h) -> rebase (0.25 h) -> 14 -> 15 -> gate (3.25 h) = **11.0 h**. With gate contention (+15 percent, M12 and M6b on the same two slots): about **12.5 h of work**, one to two days of wall clock. The owner sees the scroll fix at about 1.5 h, the right lists at about 7.5 h (after M12 merges), providers and availability at about 11 to 12.5 h (after M6b merges).

## Pre-dispatch rulings (shared by several tasks)

(MPR numbers. "(owner qN)" marks the owner's answer of 2026-10-17, every one the recommendation; the raw answers are `docs/design/questions/2026-10-17-models-answers.json`. "Cost if wrong" is the price of the ruling being wrong. Decision numbers are in `docs/research/decisions-log.md`, row 94.)

- **MPR1** [M7R41, spec 3] **One source.** `listAvailable(runtime, patterns, sessionScope?)` is the only code that decides which models a context may use: session scope, else the models `enabledModels` resolves to against the runtime's available list (Pi's `resolveModelScopeWithDiagnostics`) when that is non-empty, else `runtime.getAvailable()`. The worker and the `models.available` helper op both call it. "Exactly the models Pi would let that context use" holds under two stated conditions: the worker re-reads settings and `models.json` before it lists (MPR25), and no provider's key is a `!command` (the worker's default store resolves it, so such a provider is offered by both and may fail at use; the helper reports it configured without running it, MC25). `models.overview`'s `enabled` flag stays what it is (not switched off, among all models) and is used only by the Settings switches. Cost if wrong: two lists again.
- **MPR2** [MC25, M7R46] **No command, no network on a read.** The helper opens the runtime over pap's credential store (`createAuthFileStore`, as `auth.login`), `refreshOnCreate: false`, `allowModelNetwork: false`, so Pi's availability refresh resolves no `!command`. A marker test proves it for `auth.json` and `models.json`. The parity test with the worker uses plain keys only. A corrupt `auth.json` throws for both stores, so the picker shows `failed` with Retry. If Pi's `checkAuth` calls the network for an expired OAuth credential, the op treats OAuth providers by pap's file facts instead; the probe is task 2 step 1 (the plan-fix red-team ran it: no network, marker files stayed absent). Cost if wrong: a picker that runs the owner's secret manager or hangs.
- **MPR3** [M7R50] **`models.available`** is `pi:read`, idempotent, `cwd` optional with the `ProjectsPort.covers` check. Its answer is `ModelSummary` rows, provider names and the origin; nothing secret.
- **MPR4** **Pickers read only `models.available` or `sessions.models`.** A source-scan test fails if a file outside `features/models/` calls `models.overview` or imports `useOverview` to build choices. `models.overview` stays for Settings, defaults (the star) and the first-run step.
- **MPR5** (owner q6) **A saved choice that is not offered stays visible** as "saved, no longer offered" (fr "Modèle enregistré, plus proposé") at the top of the list, still pickable; nothing replaces or erases it silently. Ruling on the red-team's question Q-B (what a run does with such a model): no run-start check in this batch; the run fails with Pi's own error, as today; the agent status warning and a server-side membership check on save are a follow-up (deferred minor D2). Cost if wrong: an unattended run fails on a model the owner switched off.
- **MPR6** (owner q1) **The picker is a popover anchored to the field, with a search box, groups by provider, scrolling**, and a bottom sheet on phones (the `Menu` pattern, `useIsPhone`). Field eager and tiny; list lazy through `useRetryableLazy` and `LazyBoundary` (`unknown_method` and a stale chunk show "reload", MP-RT-09). Search tokens all must match provider, id or name, ranked exact > prefix > word boundary > substring; groups in the source's order (never re-sorted, pi-web #783); rows 44 px on coarse pointers; the list scrolls inside `max-h-popover`. ARIA is the combobox pattern: the search input has `role="combobox"`, `aria-expanded`, `aria-controls` and `aria-activedescendant`; the list is `role="listbox"` with `role="option"` rows and `aria-selected`. Keys: Up and Down move the active row, Enter picks, Escape closes, PageUp and PageDown jump a page, Ctrl+Home and Ctrl+End go to the first and last row (plain Home and End move the caret of the search input). The search input has `pointer-coarse:text-base` (no iOS zoom). States: loading, failed with retry, empty with a link to Settings > Models, no match, truncated. No module-level store.
- **MPR7** **`Select`**: bounded by `max-h-available`, scroll buttons, a visible thin scrollbar on the viewport. Any long `Select` benefits.
- **MPR8** [owner c3, M7R133; MP-RT-02, MP-RT-03] **Provider form callers.** `models.provider.get|save|remove` are `pi:admin` (browser sessions only). Save and remove take the password step-up; get does not. Audit `provider_saved {provider}`, `provider_removed {provider}`; ids only. `get` and `remove` take any id the file holds (`z.string().min(1).max(128)`); `get` runs the form's own schema over what it read and answers `editable: false` with a reason (`not_in_file`, `builtin`, `api_unsupported`, `url_unsupported`, `needs_raw_editor`) for a provider outside the form's grammar, never an error; `remove` works for every non-built-in id of the file. The `baseRevision` of a save is the `revision` that `models.provider.get` returned when the form opened (for a new provider, `get` with no id), never a fresh read at save time, so a change made meanwhile is a `conflict` and the form reloads with `get`. `save` lists `sensitiveParams: ["id","mode","baseRevision"]` and carries `id` and `mode` at the top level (equal to `provider.id`), so a replay with the same command id and another target is `bad_request`.
- **MPR9** (owner q4) **Base URL policy: `https:`, or `http:` to this machine only** (`localhost`, `127.0.0.0/8`, `[::1]`); no credentials, query or fragment; at most 2048 characters. A LAN `http:` server goes through the raw editor, which accepts what Pi accepts. The policy is ONE named constant, `HTTP_PLAINTEXT_POLICY` (`"loopback" | "any"`) in `packages/contracts/src/base-url.ts`, and one test table, `BASE_URL_TABLE` (url, verdict under `loopback`, verdict under `any`) in `base-url.test.ts`; the tests run both columns and check the shipped column through the constant. A later owner flip to `"any"` is that one line, plus the two sentences of the `settings-providers` catalog (the policy text and the clear-text warning), and no test changes. Trade-off recorded for the owner (red-team MP-RT-04): the raw editor, behind the same step-up, accepts any URL Pi accepts, so loopback-only is a speed bump toward a less guarded editor and not a barrier; the usual self-hosted case (Ollama on a GPU box or NAS on the LAN) needs the raw editor under this policy. Under `"any"` the form would warn "the key travels in clear on your network" (`keyTravelsInClear`) when a key (stored or env) is attached, with no warning for `auth: none`. Cost if wrong: a LAN Ollama needs the raw editor, or key-bearing traffic goes in clear.
- **MPR10** **API types the form offers:** `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, `mistral-conversations`. Each loads in Pi's own loader (task 9 test `save.each-api-type-loads`). Pi 1.1.0 also loads a provider with an unknown `api`, so the zod enum is the only guard against a typo; there is no "Pi rejects it" test. Bedrock, Vertex, Azure, Codex and `pi-messages` need ambient credentials or special flows: raw editor.
- **MPR11** [ADR 0026; MP-RT-18] **`models.json` write rules.** Strict JSON only; an integer literal of 16 or more digits is refused; `providers[id]` is edited, every unowned key of the provider and of each model is kept (models match by `id`); other providers untouched; revision (HMAC) checked inside the queue and again right before the write; Pi's own loader validates the result on a private copy; `writePiFile` (temp, 0600, rename, hard link refused); the existing `enabledModels` resync follows. Output is `JSON.stringify(root, null, 2)` plus a newline: formatting may change, content does not. **Comments (the red-team's question A, ruled here, KISS and secure).** Pi accepts `//` line comments and trailing commas in `models.json`, so a hand-edited file may have them, and a rewrite would drop them silently. The form never rewrites such a file: `models.provider.get` answers `{ editable: false, reason: "needs_raw_editor" }` for every provider of the file, `models.provider.save` and `remove` answer `config_invalid` with the single issue path `$.file`, and the UI turns both into one sentence with a link to the raw editor ("Ce fichier contient des commentaires ou des virgules finales: modifiez-le dans l'éditeur brut"). The "rewrite without comments" alternative is rejected: it is a destructive path for a file the owner annotated, and the raw editor already preserves comments. One code, pinned by a test in task 9 (get and save) and task 12 (UI).
- **MPR12** (owner q7, q8; MC24) **Keys and headers.** The API key goes to Pi's `auth.json` through the existing `models.setApiKey`, with an "environment variable" option (`"$NAME"` in `models.json`); never a key in `models.json`; a local server without a key gets the dummy literal `local-no-key`. The provider form has no key field: after a successful save of a `stored` provider the UI offers the existing `ApiKeyForm` (already step-up, already empties itself, `autoComplete="off"`, `name="api-key"`), which removes the typed-key state, the `finally` clearing and the partial-success wording from the form (MP-RT-10). The form never writes a `!command`. Custom headers are allowed (at most 8); a header whose name holds a credential word takes only an environment reference; a literal header value never starts with `!` and never contains `$` (Pi interpolates `$X` and `${X}` in a literal, MP-RT-22: use the env option). Cost if wrong: a secret in a file the raw editor masks only on a best-effort basis.
- **MPR13** (owner q9) **Built-in ids** (`builtinProviders()` of `pi-ai`) cannot be created, edited or removed by the form: it only adds providers. A clash is a `config_invalid` issue at `$.provider.id`. Changing a built-in's endpoint (a proxy) is the raw editor's.
- **MPR14** **Remove** deletes the provider entry only. The stored key is removed only if the owner ticks it (`auth.logout` in the same queue slot). `enabledModels` patterns are left; the availability view lists patterns that match nothing with a "Clean up" button (existing `prune`).
- **MPR15** [M7R66] **Discover and test stance.** The provider host is the owner's own and may be private; no DNS guard (unlike M12 push, whose endpoints a browser chooses). Callers: browser session only, `pi:admin`; discover takes the step-up, test does not (as today); 15 s, no redirect, no cookie, a status class never a body. Saving a provider's endpoint takes the step-up, which closes "a stolen session repoints a provider that already holds a key".
- **MPR16** (owner q3) **Availability view: the mode first** ("All models of the connected providers" / "My selection"), then the switches, then the preview. It writes only through `models.setEnabled` (no step-up, M7R133), previews with `models.available`, shows unconnected providers' models as "not connected", and lists patterns that match nothing. Switching to "All models" calls `clear`, which deletes the owner's curated `enabledModels` (globs and patterns for providers not signed in right now included) with no undo: it asks for confirmation first and names the number of patterns it removes (MP-RT-17).
- **MPR17** (owner q5; MC52, M10R110) **Extension providers** appear in Settings as a read-only list loaded on the owner's click, through a helper op that does the offline extension load `models.usage` already does (global extensions only, no project scope, `projectTrusted: false`). Otherwise they appear only in a session's menu. They are not part of no-session pickers (stated in the picker footnote).
- **MPR18** (owner q11) **C hook.** Nothing in the UI for per-person, project or agent restrictions. A pap-side policy would filter in the daemon after the helper or the worker answers; the interface line is documented in the spec and ADR 0070, nothing is built.
- **MPR19** **No new client store.** The hooks keep their state in the component; nothing outlives a sign-out. A test renders, signs out (unmounts the app tree) and finds no module-level state.
- **MPR20** [MC40] **Caps.** Providers in the file at most `MODELS_LIMITS.providers` (300); models per provider in the form at most 500; headers at most 8; a create at the cap is refused. A discovery of more than 500 models imports at most 500, chosen by the owner.
- **MPR21** [MP-RT-06] **Daemon cache of `models.available`:** 10 s TTL, keyed by (cwd or none), at most 32 keys (expired entries are swept before the cap is judged; when full a new key is answered but not stored); **single-flight** (concurrent reads of one key share one helper run); a **generation counter** (`clear()` bumps it, and a read that started before the bump never stores its result). `clear()` runs after every write that goes through the models service queue (`setEnabled`, `setDefault`, `setDefaultThinking`, config save, provider save and remove) **and** in the three paths outside the queue: `setApiKey`, `logout` and the login flow's `onSignedIn`. A trust change (the `trust` module owns it, this batch does not edit it) is picked up when the 10 s TTL runs out; the docs say so. Cost if wrong: a stale picker right after a Settings change.
- **MPR22** **Copy.** French with vous and accents; the picker footnote about extension models and about `!command` keys, and the form's "advanced settings kept" note, are written in tasks 5b, 11 and 14; no copy claims more than the code does.
- **MPR23** (owner q10) **Merge the fix first.** A0 (the `Select` fix) merges alone as soon as C1 passes; chain A merges as soon as it is ready (after M12), before B; the feature rebases once. Order: A0, M12, A, M6b, B.
- **MPR24** (owner q2) **The provider form: starter presets, then one short form.** Preset cards first (Ollama local, LM Studio, vLLM, OpenRouter, OpenAI-compatible, Anthropic-compatible, Gemini-compatible, custom); a preset only prefills fields and is not a Pi concept. Under the loopback policy (MPR9) the local presets point at `http://localhost:...`.
- **MPR25** [MP-RT-01] **A warm worker is made fresh before it lists.** `freshAvailable(runtime, settings, sessionScope, idle)` in `available-models.ts` does `await settings.reload(); await runtime.refresh({ allowNetwork: false })` and then `listAvailable`. `handleGetAvailableModels` and `handleSetModel` call it. When the session is running (`isIdle === false`) it lists from the snapshot the run started with and does not refresh (a model switch is refused while a run is in flight anyway, M7R43). Both Pi calls are offline. Cost if wrong: the session menu disagrees with the agent form until the worker is released (30 min).
- **MPR26** [MP-RT-19] **Model and provider names are untrusted text** (they come from `models.json`, discovery and extensions): the picker vm clips them to 256 characters and strips control, bidi and zero-width characters with `stripHidden`; React renders them as text.
- **MPR27** [MP-RT-05] **The scroll proof is real and blocking.** There is no browser CI. The controller runs the Playwright podman image (m0-m1 ruling R51: `mcr.microsoft.com/playwright:v<exact>-noble`, rootless, headless, `playwright run-server`) on WebKit and Chromium: step C1 for the `Select` (A0 does not merge without it) and step C2 for the picker inside a modal Dialog (A does not merge without it). The jsdom tests stay as a guard. The `Popover` is `modal` (Radix `Popover` with `modal`) so that wheel and touch scroll reach its list when it opens from a modal Dialog (the new-lane and new-agent dialogs); C2 is what decides, and the fallback is a `container` prop that portals the popover into the dialog.
- **MPR28** [MP-RT-22] **`$NAME` can name any variable of the helper's environment.** An `apiKey` or header env reference plus a changed `baseUrl` can send a variable of the helper's environment to a chosen host. It needs the browser session and the step-up, and the raw editor allows the same, so this adds no capability; ADR 0069 says so.
- **MPR29** [MP-RT-23] **Backups.** M6b excludes `models.json`, `auth.json` and `settings.json` from the backup (M6bR3). `docs/agents/models.md` and the restore summary say: after a restore, providers, the model selection and keys must be set again.

## Chain A: the bug fix

A0 is task 4 (merges first, alone). A-back is tasks 1 to 3; A-front is tasks 4, 5a, 5b, 6; they join at task 7.

### Task 1: `listAvailable`, the single source (worker side)

**Chain:** A-back. **Model:** Sonnet implementer; Sonnet reviewer. **Gate:** unit (the worker cases use a real Pi runtime over a temporary agent dir; the int proof is task 3).

**Files:**
- Create: `packages/pi-host/src/available-models.ts`, `packages/pi-host/src/available-models.test.ts`
- Modify: `packages/pi-host/src/model-commands.ts` (the `listedModels` function becomes a call to `freshAvailable`; imports)
- Test (existing, stays green): `packages/pi-host/src/model-commands.test.ts`, `host.models.int.test.ts` (run in task 3's gate)

**Interfaces (produces):**
```ts
// packages/pi-host/src/available-models.ts
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";

export type AvailabilityOrigin = "session" | "scope" | "signed-in";
export interface Availability {
  readonly models: readonly Model<Api>[];
  readonly origin: AvailabilityOrigin;
}
/**
 * The models a context may use, in Pi's order (M7R41): the session's own scope, else the scope `enabledModels` names
 * (resolved by Pi against the runtime's available list), else everything the runtime has credentials for. A scope
 * that resolves to nothing (patterns naming only unsigned or unknown models) does not hide the signed-in list.
 */
export async function listAvailable(
  runtime: ModelRuntime,
  patterns: readonly string[] | undefined,
  sessionScope?: ReadonlyArray<{ readonly model: Model<Api> }>,
): Promise<Availability> {
  if (sessionScope !== undefined && sessionScope.length > 0)
    return { models: sessionScope.map((scoped) => scoped.model), origin: "session" };
  if (patterns !== undefined && patterns.length > 0) {
    const { scopedModels } = await resolveModelScopeWithDiagnostics([...patterns], runtime);
    if (scopedModels.length > 0)
      return { models: scopedModels.map((scoped) => scoped.model), origin: "scope" };
  }
  return { models: await runtime.getAvailable(), origin: "signed-in" };
}
```

```ts
/**
 * A warm worker re-reads what the helper reads fresh (MPR25): Pi's SettingsManager caches `enabledModels` until
 * `reload()` and its ModelRuntime does not see an edited models.json until `refresh()`. Both calls are offline. A run in
 * flight keeps the snapshot it started with (a model switch is refused while it runs, M7R43).
 */
export async function freshAvailable(
  runtime: ModelRuntime,
  settings: Pick<SettingsManager, "reload" | "getEnabledModels">,
  sessionScope: ReadonlyArray<{ readonly model: Model<Api> }> | undefined,
  idle: boolean,
): Promise<Availability> {
  if (idle) {
    await settings.reload();
    await runtime.refresh({ allowNetwork: false });
  }
  return listAvailable(runtime, settings.getEnabledModels(), sessionScope);
}
```
(Import `type SettingsManager` from `@earendil-works/pi-coding-agent` next to `ModelRuntime`.) `model-commands.ts` uses `(await freshAvailable(session.modelRuntime, session.settingsManager, session.scopedModels, session.isIdle)).models` in `handleGetAvailableModels` and in `handleSetModel` (the existing second `isIdle` read right before the switch stays). Verified by running the function against a real Pi runtime in a scratch agent dir (plan fix): the stale view lacks the new provider, `freshAvailable` lists it, and equals a brand-new runtime's list.

**Rulings:** MPR1, MPR25.

- [ ] **Step 1 (RED):** `available-models.test.ts` with `makeModelsBed()` (temp agent dir, `PI_OFFLINE=1`), a runtime from `ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false, allowModelNetwork: false })` over an `auth.json` holding an API key for `anthropic` and a `models.json` custom provider `mine` with a key. Each case compares `listAvailable(...)` to Pi's own calls computed in the test (`resolveModelScopeWithDiagnostics`, `runtime.getAvailable()`), by ordered `provider/id` list and by `origin`:
  - `no-patterns-is-signed-in`: patterns `undefined` and `[]` equal `getAvailable()`, origin `signed-in`, and no model of an unsigned provider (`openai`) is in it.
  - `provider-glob`: patterns `["anthropic/*"]` equal Pi's scope result, origin `scope`.
  - `thinking-suffix`: `["anthropic/<a real id>:high"]` returns that model once.
  - `scope-matches-nothing-falls-back`: patterns `["openai/*"]` (unsigned) equal `getAvailable()`, origin `signed-in` (Review Focus 3).
  - `session-scope-wins`: a two-model session scope beats patterns, origin `session`, order kept.
  - `order-is-pis`: the order is the runtime's registration order, never sorted.
  - `does-not-list-unsigned-provider-models-even-if-patterns-name-them`: patterns `["anthropic/*", "openai/*"]` hold no `openai` model.
  - `worker.warm-sees-new-provider` (Review Focus 9): open the runtime and a `SettingsManager.create(project, agentDir)`, list once, then rewrite `models.json` with a second provider `fresh`; `listAvailable` alone still lacks it (documents the Pi fact), `freshAvailable(..., idle: true)` lists it and equals the list of a runtime created afterwards.
  - `worker.warm-sees-new-enabled-models`: rewrite `settings.json` `enabledModels`; `freshAvailable` follows it (origin `scope`), the stale call does not.
  - `worker.busy-keeps-snapshot`: with `idle: false` neither Pi call is made (spy on `reload` and `refresh`) and the list is the old one.
  - `worker.handlers-use-fresh`: `handleGetAvailableModels` and `handleSetModel`, given a session-like object over the real runtime and settings, answer with the fresh list (and `set_model` accepts a model of the provider added after the session was created).
- [ ] **Step 2:** `pnpm exec vitest run --project unit packages/pi-host/src/available-models.test.ts` fails (module missing).
- [ ] **Step 3:** write `available-models.ts` exactly as above; switch `model-commands.ts` `listedModels` to call it; delete the inline body.
- [ ] **Step 4:** run the new test and `model-commands.test.ts`: green.
- [ ] **Step 5 (mutation checks, real):** temporarily apply each mutant, run `available-models.test.ts`, see the named test fail, revert (`git checkout -- packages/pi-host/src/available-models.ts`): (M1) delete the final fallback condition so an empty scope returns `[]` (expect `scope-matches-nothing-falls-back` red); (M2) return `runtime.getModels()` instead of `getAvailable()` (expect `no-patterns-is-signed-in` red); (M3) `.sort()` the result by id (expect `order-is-pis` red); (M4) check `patterns` before `sessionScope` (expect `session-scope-wins` red); (M5) delete `await settings.reload()` in `freshAvailable` (expect `worker.warm-sees-new-enabled-models` red); (M6) delete `await runtime.refresh(...)` (expect `worker.warm-sees-new-provider` red); (M7) make the handlers call `listAvailable` directly (expect `worker.handlers-use-fresh` red). Record the seven outcomes in the commit body.
- [ ] **Step 6:** `pnpm lint && pnpm typecheck` pass; `git commit -m "refactor(pi-host): one listAvailable function for the worker's model list, read fresh (models batch)"`

### Task 2: `models.available` contract and helper op

**Chain:** A-back. **Model:** Sonnet implementer; **Opus** reviewer (a read that must run no command and no network; a result a token can read). **Gate:** unit + int for the helper op. Its contract commit is merged into `a-front` as soon as it passes review (task 5b needs it).

**Files:**
- Create: `packages/contracts/src/models-available.ts`, `packages/contracts/src/models-available.test.ts`, `packages/pi-host/src/helper/ops/models-available.ts`, `models-available.test.ts`, `models-available.marker.test.ts`
- Modify (additive): `packages/contracts/src/{models-methods.ts (spread + import), pi-helper.ts (HELPER_OPS line), methods-idempotent.ts, methods.test.ts, index.ts}`, `packages/pi-host/src/helper/ops.ts` (import + registry line), `packages/pi-host/src/helper/ops/models-open.ts` (one exported function `openStoreRuntime`)

**Interfaces (produces):**
```ts
// contracts/models-available.ts
export const AVAILABLE_MODELS_MAX = 2000;
export const AvailableModels = z.object({
  models: z.array(ModelSummary).max(AVAILABLE_MODELS_MAX),
  /** Providers of `models`, in first-appearance order, with their display names (clipped at 256). */
  providers: z.array(z.object({ id: z.string().min(1).max(128), name: z.string().max(256) }).strict()).max(MODELS_LIMITS.providers),
  origin: z.enum(["scope", "signed-in"]),
  /** Models were left out to stay within the count or the byte budget. */
  truncated: z.boolean(),
}).strict();
// method: "models.available": pi:read, idempotent true, params z.object({ cwd: Cwd.optional() }).strict(), result AvailableModels,
//   errors ["invalid_cwd","capacity","timeout","helper_failed","config_invalid","config_path_refused"]
// helper: HELPER_OPS["models.available"] = { params: NONE, result: AvailableModels }
```
`origin` has no `session` here: the helper has no session.

```ts
// models-open.ts (additive)
/** Pi's runtime over pap's credential store (MC25): availability never resolves a stored `!command`. */
export async function openStoreRuntime(ctx: Pick<HelperContext, "agentDir" | "home">): Promise<ModelRuntime> {
  const roots = [ctx.agentDir, ctx.home];
  const modelsPath = join(ctx.agentDir, "models.json");
  await guardFile(modelsPath, roots);
  return ModelRuntime.create({
    credentials: createAuthFileStore(ctx),
    modelsPath,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
}
```
(`createAuthFileStore` is already guarded and reads auth.json through the Pi file boundary; import it from `./auth-store.ts`. `models-open.ts` must not import `auth.ts` to avoid a cycle.)

The op: open settings (`openSettings(ctx)`: trust and project patterns as the overview), open `openStoreRuntime`, `listAvailable(runtime, settings.manager.getEnabledModels())`, map through `summaryOf`, build `providers` from `runtime.getProviders()` names, cut to `AVAILABLE_MODELS_MAX` and 600 000 bytes (`truncated: true`), warnings are not returned (the overview owns them).

**Rulings:** MPR1, MPR2, MPR3.

- [ ] **Step 1 (probe, 15 minutes, no commit):** in a scratch test, put an `oauth` credential with an expired `expires` in `auth.json` of a temp agent dir, open `openStoreRuntime`, call `runtime.getAvailable()` with `blockedAttempts` read afterwards. If it records an attempt, `checkAuth` refreshes over the network: then implement the op's OAuth branch described in MPR2 (an OAuth provider counts as configured when a credential of type `oauth` is stored; the op filters `getAvailable()` through that fact for those providers) and keep the test below; if not, record "no network" in the task's commit body and skip the branch. (The red-team ran this probe on 2026-10-17 against Pi 1.1.0: no network call, no `!command` run, so the branch is expected to be skipped; still record it.)
- [ ] **Step 2 (RED):** contract tests: `AvailableModels` refuses an extra field, 2001 models, `origin: "session"`; `models.available` is `pi:read`, idempotent, accepts `{}` and `{ cwd }`, refuses `{ cwd: "" }`; `methods.test.ts` list gains the name. Helper tests (`makeModelsBed`, `PI_OFFLINE=1`, `blockedAttempts` empty after each):
  - `available.signed-in-only`: with a key for `anthropic` and a `models.json` provider `mine`, the answer lists exactly their models, `origin: "signed-in"`, no `openai` model, and equals `listAvailable` over the same runtime.
  - `available.scoped`: global `settings.json` `enabledModels: ["mine/*"]` gives only `mine`'s models, `origin: "scope"`.
  - `available.scope-matches-nothing-falls-back`: `["openai/*"]` gives the signed-in list.
  - `available.project-untrusted`: a project `.pi/settings.json` with patterns is ignored when the trust store says untrusted; applied when trusted (reuse the overview test's trust helper).
  - `available.provider-names`: `providers` holds `{id, name}` in first-appearance order, one per provider with models.
  - `available.truncates`: a `models.json` with 2100 models for one provider answers 2000 and `truncated: true`; the byte budget case likewise.
  - `available.marker.no-command` (Review Focus 1): `auth.json` has `anthropic: { type: "api_key", key: "!touch <marker>" }` written by hand and `models.json` has a provider with `apiKey: "!touch <marker2>"`; the op runs; neither marker file exists afterwards; the provider still counts as signed in.
  - `available.oauth-expired.no-network` (Review Focus 2): an expired OAuth credential; `blockedAttempts` is empty; the answer arrives; the provider is listed.
  - `available.token-readable-result-has-no-secret`: the serialised answer contains neither the stored key nor the `models.json` key (marker strings).
  - `available.parity-with-worker`: build a runtime the worker's way (`ModelRuntime.create({ authPath, modelsPath })`, default store, default options) over the same temp dir with **plain keys only** (a `!command` key is the one stated difference, MPR1: the worker resolves it, the helper does not; a second case asserts exactly that, with a marker); `listAvailable` over it gives the same ordered ids as the op.
  - `available.corrupt-auth-json`: an `auth.json` that is not JSON makes the op fail (`helper_failed` at the daemon) and the worker's store throw too; the answer never carries file text.
- [ ] **Step 3:** run them: fail.
- [ ] **Step 4:** implement contracts, helper op, registry lines, `openStoreRuntime`. `pnpm typecheck` green (the exhaustive `HELPER_OPS` consumers force the daemon service to compile only after task 3; this task adds the op to `HELPER_OPS` and an entry in the helper registry, and `service.ts` needs no change yet because `run()` is generic).
- [ ] **Step 5 (mutation checks, real):** (M1) make the op call `openRuntime` (Pi's file store) instead of `openStoreRuntime`: `available.marker.no-command` must go red (if it does not, the test is wrong: fix the test); (M2) skip `openSettings` (ignore patterns): `available.scoped` red; (M3) add `warnings` to the answer: the strict schema rejects it in `available.token-readable-result-has-no-secret` or the contract test. Revert each.
- [ ] **Step 6:** `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit packages/contracts packages/pi-host/src/helper/ops/models-available` green; `pnpm exec vitest run --project integration packages/pi-host/src/helper` (the helper pool bed) green; `git commit -m "feat(models): models.available helper op over pap's credential store"`

### Task 3: Daemon `models.available`, guarded single-flight cache, production wiring

**Chain:** A-back. **Model:** Sonnet implementer; **Opus** reviewer (cache races and invalidation across paths outside the write queue, MP-RT-06; the same Opus pass as task 2 may take both when they land together). **Gate:** unit + int.

**Files:**
- Create: `apps/daemon/src/modules/models/available.ts`, `available.test.ts`, `available.int.test.ts`
- Modify: `apps/daemon/src/modules/models/{service.ts (compose, at most 8 lines), rpc.ts (Pick entry + handler), index.ts (if the type list needs it)}`, `apps/daemon/src/compose-pi.test.ts` (method list), `packages/pi-host/src/host.models.int.test.ts` (parity cases)

**Interfaces (verified by running it in a scratch directory, plan fix: single flight, a write during a read, TTL, the 32-key cap, a failure not cached):**
```ts
// available.ts
export const AVAILABLE_TTL_MS = 10_000;
export const AVAILABLE_CACHE_KEYS = 32;

export interface AvailableCache {
  /** A cached value, or the run in flight for `key`, or a new run of `load`. Concurrent callers share one run. */
  read(key: string, now: number, load: () => Promise<AvailableModels>): Promise<AvailableModels>;
  /** Every write path calls this: drops values and makes runs already in flight unable to store their result. */
  clear(): void;
}

export function createAvailableCache(): AvailableCache {
  const values = new Map<string, { readonly value: AvailableModels; readonly at: number }>();
  const flying = new Map<string, Promise<AvailableModels>>();
  let generation = 0;
  return {
    read(key, now, load) {
      const hit = values.get(key);
      if (hit !== undefined && now - hit.at < AVAILABLE_TTL_MS) return Promise.resolve(hit.value);
      const running = flying.get(key);
      if (running !== undefined) return running;
      const started = generation;
      const run = load().then(
        (value) => {
          if (flying.get(key) === run) flying.delete(key);
          for (const [other, held] of values) if (now - held.at >= AVAILABLE_TTL_MS) values.delete(other);
          if (started === generation && (values.has(key) || values.size < AVAILABLE_CACHE_KEYS))
            values.set(key, { value, at: now });
          return value;
        },
        (error: unknown) => {
          if (flying.get(key) === run) flying.delete(key);
          throw error;
        },
      );
      flying.set(key, run);
      return run;
    },
    clear() {
      generation++;
      values.clear();
      flying.clear();
    },
  };
}
// service.ts gains: available(caller: Caller, cwd?: string): Promise<AvailableModels>
```
`available(caller, cwd)` = `checkedCwd`, key `cwd ?? ""`, `cache.read(key, clock.now(), () => run("models.available", {}, READ_DEADLINE_MS, cwd))`, result parsed with the strict schema. `cache.clear()` is called **after** the helper run of: every method that writes through `serialised(...)` (`setEnabled`, `setDefault`, `setDefaultThinking`, `config.save`, and tasks 10's `provider.save|remove`, success or failure), **and** in the three paths that do not use the queue: `setApiKey`, `logout` and the login flow's `onSignedIn` (read `service.ts` to place the calls). A trust change is not wired (the `trust` module is not edited): it shows when the TTL ends; `docs/agents/models.md` says so (task 7).

**Rulings:** MPR3, MPR21.

- [ ] **Step 1 (RED):** `available.test.ts` (fake `Clock`, deferred promises, no timers): `cache.hit` (a read inside 10 s runs `load` once; after 10 s again); `cache.single-flight` (two concurrent reads of one key run `load` once, both get the value; two keys run twice); `cache.write-during-read` (Review Focus 12: start a read, call `clear()`, resolve the old read: the caller still gets the old value, but the next read runs `load` again and gets the new one); `cache.cap` (the 33rd distinct key is answered but not stored; expired entries are swept so they never block a new key); `cache.failure-not-cached`. Service test with a fake pool: `available.invalidated-by-<method>` for each of `models.setEnabled`, `setDefault`, `setDefaultThinking`, `config.save`, `setApiKey`, `logout`, and the login flow's `onSignedIn` (one test per path, so none can be dropped silently); a cwd outside the caller's projects is `invalid_cwd` before any helper run; the helper result is parsed with the strict schema (an extra field from a fake helper answers `helper_failed`); a rejected helper run is not cached.
- [ ] **Step 2:** `available.int.test.ts` (real `createHelperPool` over `packages/pi-host/src/helper/main.ts`, as `service.int.test.ts` does, temp `agentDir`, `NETWORK_GUARD`): `models.available` through the real service lists the signed-in models; after `setEnabled` with a provider switch off the next answer changes (cache invalidated); after a real `setApiKey` for a second provider the next answer lists it at once; four concurrent first calls (the new-lane dialog's four slots) cost one helper run (count pool runs) and none ends in `capacity`; a marker `!command` key in the temp `auth.json` does not run. **Production wiring (M11a I2):** `compose-pi.test.ts` asserts `models.available` is among `models.rpc`'s keys of the module that `buildPi` returns, and a test builds the module through `createModelsModule` the way `compose-pi.ts` does (not a hand-assembled bed) and calls the handler.
- [ ] **Step 3:** `host.models.int.test.ts` gains two cases with the same temp agent dir (key for a built-in provider, `enabledModels` pattern), a real worker session and the helper op:
  - `sessions.models and the helper agree`: the worker's `get_available_models` and the helper op give the same ordered ids once the scripted provider's models are filtered out.
  - `sessions.models and the helper agree after a write` (Review Focus 9): start the worker and a session first, then change `enabledModels` through `models.setEnabled` and add a `models.json` provider, then assert the two sources still agree, that `set_model` accepts the new provider's model, and that a prompt on the session still runs (the refresh did not break the live session).
- [ ] **Step 4:** run unit + the three int files (heavy slot): fail; implement; pass. `pnpm lint && pnpm typecheck`.
- [ ] **Step 5 (mutation, real):** drop the generation check (`started === generation`): `cache.write-during-read` red; drop the in-flight map: `cache.single-flight` and the four-concurrent int case red; drop one `cache.clear()` call (each of the seven paths in turn is a one-line mutant): its named invalidation test goes red; drop the `checkedCwd` call: the `invalid_cwd` test red; change the TTL comparison to `<=` with a clock exactly at 10 s: `cache.hit` red; raise the key cap by one: `cache.cap` red. Revert each.
- [ ] **Step 6:** `git commit -m "feat(models): models.available through the daemon with a guarded single-flight cache"`

### Task 4: The `Select` primitive is bounded and scrolls

**Chain:** A0 (first of A-front; merges alone, before everything else). **Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets, then the controller proof C1 (blocking).

**Files:**
- Modify: `packages/ui/src/primitives/Select.tsx`, `packages/ui/src/utilities.css` (one `@utility max-h-available`, one viewport rule), `apps/web/src/gallery/sections/FormFigures.tsx` (a long-list figure), the existing Select tests (`controls.test.tsx` holds them; add `Select.long.test.tsx` rather than grow it)
- Test: `packages/ui/src/primitives/Select.long.test.tsx`

**Interfaces:** `Select`'s props are unchanged. New utility:
```css
/* packages/ui/src/utilities.css, next to max-h-app */
@utility max-h-available {
  max-height: var(--radix-select-content-available-height, var(--app-viewport-height, 100dvh));
}
/* Radix hides the viewport's scrollbar with an injected rule of one attribute; two attributes win. */
[data-radix-select-viewport][data-slot="select-viewport"] {
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}
[data-radix-select-viewport][data-slot="select-viewport"]::-webkit-scrollbar {
  display: block;
  width: var(--spacing-s2);
}
```
(Both tokens exist in `tokens.css`: `--border-strong` and `--spacing-s2`. Safari 16.4 lacks `scrollbar-width`, hence the `::-webkit-scrollbar` rule; the scroll buttons below are the touch and keyboard affordance everywhere.)

`Select.tsx`: `Radix.Content` class gains `max-h-available overflow-hidden`; inside it `<Radix.ScrollUpButton className=BTN><Icon icon={IconChevronUp}/></Radix.ScrollUpButton>`, the viewport gets `data-slot="select-viewport"`, then `<Radix.ScrollDownButton ...>` with the existing chevron icon flipped (`IconChevronUp` exists or add the import from `../icons.ts`; if only `IconChevronDown` exists, rotate it with `rotate-180`). Buttons `h-control pointer-coarse:min-h-11 flex items-center justify-center text-muted`.

**Rulings:** MPR7, MPR27.

- [ ] **Step 1 (RED):** `Select.long.test.tsx` renders `Select` open with 300 options: the content element has the class `max-h-available`; the viewport has `data-slot="select-viewport"`; keyboard `End` highlights the last option and `Home` the first; typing a letter jumps (Radix typeahead); choosing the 250th option calls `onChange` with its value. A CSS test in the existing `tokens.test.ts` style (or a new `utilities.test.ts`) reads `utilities.css` and asserts the `max-h-available` utility and the viewport rule exist (so a refactor cannot drop them). jsdom has no layout, so scroll buttons are not asserted here.
- [ ] **Step 2:** run: fail. **Step 3:** implement. **Step 4:** `pnpm exec vitest run --project unit packages/ui` green; `pnpm build && pnpm budgets` (delta under 0.5 KB gzip).
- [ ] **Step 5 (the figure, for C1):** add the gallery figure "Select, 300 options" in `FormFigures.tsx` (a `Select` with 300 generated options, a stable test id `gallery-select-long`). The jsdom tests above are a guard; they cannot prove that a list scrolls (no layout) and the class-name assertions are not the proof. Compare the render with the CHOSEN board option and the Select style of `docs/design/explorations/08-settings-appearance.html` (decision 80) and say so in the commit body.
- [ ] **Step 5b (controller step C1, BLOCKING, not an implementer task; see "Controller steps"):** the controller proves the scroll in WebKit and Chromium on the built gallery. A0 does not merge without a green C1 and its two screenshots in the ledger; "deferred to CI" is not an outcome (there is no browser CI).
- [ ] **Step 6 (mutation):** remove `max-h-available` from the class: `Select.long.test.tsx` red; remove the viewport rule from the CSS: the CSS test red. Revert.
- [ ] **Step 7:** `git commit -m "fix(ui): Select is bounded to the viewport and scrolls"`. After C1 the controller merges A0 to `main` alone and rebuilds the preview.

### Task 5a: Popover primitive, picker view-model, hook, catalog and scan test

**Chain:** A-front. **Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets.

**Files:**
- Create: `packages/ui/src/primitives/Popover.tsx` (+ `Popover.test.tsx`); `apps/web/src/features/models/picker/{model-picker.vm.ts, use-available-models.ts, index.ts}` and their tests (`model-picker.vm.test.ts`, `use-available-models.test.tsx`); `apps/web/src/i18n/catalog/model-picker.ts` + `apps/web/src/i18n/register-model-picker.ts`; `apps/web/src/features/models/picker/sources.scan.test.ts`
- Modify (whole lines): `packages/ui/src/index.ts` (export `Popover`), `packages/ui/src/utilities.css` (`@utility max-h-popover`), `apps/web/src/i18n/index.ts` (one `MessageKey` line), `apps/web/src/i18n/catalog-keys.test.ts` (one entry)

**Interfaces (produces):**
```ts
// features/models/picker/model-picker.vm.ts
export interface PickerModel { readonly provider: string; readonly id: string; readonly name: string; readonly reasoning: boolean; readonly contextWindow?: number }
export interface PickerGroup { readonly provider: string; readonly label: string; readonly rows: readonly PickerModel[] }
export const modelKey = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`;
/** Names are untrusted text (MPR26): clipped to 256 characters and run through `stripHidden`. */
export function toPickerModel(summary: ModelSummary): PickerModel;
/** Tokens must all match provider, id or name; ranked exact > prefix > word boundary > substring; groups keep the source order; rows keep it within a group unless a query ranks them. */
export function groupAndRank(models: readonly PickerModel[], labels: ReadonlyMap<string, string>, query: string): PickerGroup[];

// use-available-models.ts
export type AvailableState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly stale: boolean; readonly reload: () => void } // stale: unknown_method or a stale chunk -> "reload the page"
  | { readonly status: "ready"; readonly models: readonly PickerModel[]; readonly labels: ReadonlyMap<string, string>; readonly origin: "scope" | "signed-in" | "session"; readonly truncated: boolean };
/** `models.available` for a folder (or none). Loads when `enabled` turns true (the list opens); keeps its state in the component only (MPR19); a change of `cwd` answers `loading` at once and never shows the previous folder's rows. */
export function useAvailableModels(cwd: string | null, enabled: boolean): AvailableState;
```
`Popover` (ui): `Popover({ open, onOpenChange, label, trigger, closeLabel, children, container? })`: Radix Popover with `modal` (MPR27) on desktop (`align="start"`, `sideOffset=4`, content bounded by `max-h-popover`), a `Dialog variant="sheet"` on phones (as `Menu` does with `useIsPhone`). `@utility max-h-popover { max-height: var(--radix-popover-content-available-height, var(--app-viewport-height, 100dvh)); }`.

**Rulings:** MPR4, MPR6, MPR19, MPR22, MPR26, MPR27.

- [ ] **Step 1 (RED), vm:** `model-picker.vm.test.ts`: `groupAndRank` with query `""` keeps source order of groups and rows; query `son` ranks `claude-sonnet` (word prefix) above `reasoning-son-x` (substring); two tokens `anthropic opus` need both; matches provider id, model id and name case-insensitively; no match gives `[]`; a 2000-model list ranks with a counted-comparison spy that asserts O(n) work (no timing). `toPickerModel.hostile-name` (MP-RT-19): a name made with `String.fromCodePoint(0x202e)` and `0x200b` comes out without them, and a 5000-character name is clipped to 256.
- [ ] **Step 2 (RED), hook:** `use-available-models.test.tsx`: no call while `enabled` is false; one `models.available` call on open with `{ cwd }` (omitted when null); `failed` then `reload` calls again; `unknown_method` and a stale-chunk error give `failed` with `stale: true`; a second open does not leak the first result (live flag); `hook.cwd-change-is-loading` (MP-RT-14): rerender with another `cwd` while the first answer is resolved: the state is `loading` at once and project A's rows are never returned for B, even if A's answer arrives late (deferred promises); **no module-level state** (MPR19): render, unmount, render a second tree with a different fake runtime result: the second shows `loading` first and then the second result.
- [ ] **Step 3 (RED), popover:** `Popover.test.tsx`: opens and closes by trigger, Escape and outside click; focus goes to the content and returns to the trigger; `modal` is set (the Radix prop, asserted through `aria-hidden` on the siblings); the phone path renders a sheet dialog.
- [ ] **Step 4 (RED), scan:** `sources.scan.test.ts` reads every non-test `.ts`/`.tsx` under `apps/web/src/features` outside `features/models/` and fails if one contains `"models.overview"` or imports `use-overview`/`useOverview`, except an allow-list of exactly `sessions/ModelMenu.tsx` (defaults only) and `auth/PiStep.tsx` (status only); and fails if any file imports `Select` and builds model options (a `ModelChoice`/`modelChoices` identifier). The allow-list is a literal array in the test.
- [ ] **Step 5:** implement `Popover`, the vm, the hook, the catalog (`en` and `fr`, vous, with accents: "Rechercher un modèle", "Aucun modèle ne correspond", "Aucun modèle disponible. Connectez un fournisseur dans les réglages.", "Modèle enregistré, plus proposé", "Les modèles ajoutés par une extension apparaissent dans le menu d'une session.", "Une clé qui est une commande est proposée mais peut échouer à l'usage.", "Rechargez la page : pap a été mis à jour.") and its register file, the `MessageKey` and `catalog-keys` lines, plus the accent test of Global Constraints.
- [ ] **Step 6:** `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit apps/web packages/ui && pnpm build && pnpm budgets`. Expected bundle: eager +0.5 to 0.8 KB gzip (hook, vm, Popover). The Popover board check (decision 80): compare with the chosen q1 option of the owner page and the menu look of board 05.
- [ ] **Step 7 (mutation):** (M1) make the hook cache its result in a module variable: the no-module-state test red; (M2) make `groupAndRank` sort groups by name: the order test red; (M3) drop the `cwd` key from the hook's state: `hook.cwd-change-is-loading` red; (M4) drop `stripHidden` in `toPickerModel`: `hostile-name` red; (M5) add `models.overview` to a feature file: the scan test red; (M6) drop `modal` from the Popover: its test red. Revert each.
- [ ] **Step 8:** `git commit -m "feat(web): popover primitive, model picker view-model and hook"`

### Task 5b: The picker list, the field, the session menu and the dialog figure

**Chain:** A-front (starts when task 2's contract commit is in `a-front`). **Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets, then the controller proof C2 at the join (blocking).

**Files:**
- Create: `apps/web/src/features/models/picker/{ModelPickerField.tsx, ModelList.tsx}` and `ModelList.test.tsx`, `ModelPickerField.test.tsx`; the figure "Model picker in a dialog, 2000 models" (a stable test id `gallery-picker-in-dialog`) in `apps/web/src/gallery/sections/OverlayFigures.tsx`
- Modify: `apps/web/src/features/models/picker/index.ts`, `apps/web/src/features/sessions/ModelMenu.tsx` (234 lines: its list body becomes `<ModelList .../>`, the file shrinks), `model-menu.vm.ts` (keep `groupModels` as a thin call into the shared vm or delete it with its test moved; no behaviour change); `ModelMenu` tests stay green

**Interfaces (produces):**
```ts
// ModelList.tsx (lazy chunk)
export interface ModelListProps {
  readonly state: AvailableState;
  readonly value: { provider: string; modelId: string } | null;
  onPick(model: PickerModel): void;
  readonly savedUnavailable?: { provider: string; modelId: string } | null; // MPR5
  readonly renderRowEnd?: (model: PickerModel) => ReactNode; // the session menu's star
  readonly footnote?: string;
}
// ModelPickerField.tsx (eager, small)
export interface ModelPickerFieldProps {
  readonly label: string;
  readonly value: { provider: string; modelId: string } | null;
  readonly cwd: string | null;
  readonly defaultLabel?: string; // when set, the first row is "Pi's default" and picking it calls onChange(null)
  readonly disabled?: boolean;
  readonly hint?: string;
  onChange(model: { provider: string; modelId: string } | null, summary?: PickerModel): void;
}
```
The field loads `ModelList` with `useRetryableLazy(() => import("./ModelList.tsx"))` inside a `LazyBoundary` (`resetKey` = the retry attempt); a failure calls `notifyLazyFailure` with the catalog's reload texts (MP-RT-09).

**Rulings:** MPR5, MPR6, MPR22, MPR26, MPR27.

- [ ] **Step 1 (RED), list:** `ModelList.test.tsx`: the search input is a combobox (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant` follows the active row), the list is `role="listbox"` with `role="option"` rows and `aria-selected` on the current model (no `aria-current`); the search is focused on open; typing filters; ArrowDown/ArrowUp move, Enter picks, Escape closes (via the field), PageDown jumps, Ctrl+End goes to the last row, plain Home/End are left to the caret (`keydown` is not prevented); rows have `min-h-11` on coarse pointers (class assertion); the search input has `pointer-coarse:text-base`; the list element has `overflow-y-auto` and `max-h-popover`; `empty` shows the Settings link; `savedUnavailable` shows the "Modèle enregistré, plus proposé" row first and it is still pickable; a group with more than 200 rows shows "show more" (200 per group, as `EnabledSwitches` does with 100); `list.hostile-name`: a name with a bidi override renders without it; `list.footnote` shows the extension and `!command` footnote.
- [ ] **Step 2 (RED), field:** `ModelPickerField.test.tsx`: shows the chosen name and provider chip; opens on click; the list chunk is dynamic (the test reads the field's source and asserts there is no static `from "./ModelList.tsx"`); `field.lazy-failure`: a loader that rejects with a stale-chunk error shows the reload message and a retry re-arms it (the `lib/lazy.tsx` test style); `defaultLabel` adds a first row; picking calls `onChange(model, summary)`; a value with no match in the list shows as saved, no longer offered; the field does not call `models.available` until opened.
- [ ] **Step 3 (RED), session menu:** the existing `ModelMenu` and `ModelBar` tests stay green (update selectors only if the DOM moved, and say so); `ModelMenu` keeps `sessions.models` as its data source, wrapped in the same `AvailableState` shape, its stars and `sessions.setModel`.
- [ ] **Step 4:** implement `ModelList`, `ModelPickerField`, the migration and the figure (2000 generated models inside a modal `Dialog`, the picker opened from a field in the dialog body; a second figure instance on a page-level field is not needed). Compare the render with the chosen q1 option and board 05 / 12 (touch) and say so in the commit body.
- [ ] **Step 5:** `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit apps/web packages/ui && pnpm build && pnpm budgets`. Expected bundle: the list chunk about 3 KB lazy; the field about +0.3 KB eager. If the initial chunk grew more than 1.5 KB in total over tasks 5a and 5b, move the vm's ranking into the lazy chunk and keep only types eager.
- [ ] **Step 6 (mutation):** (M1) remove `overflow-y-auto` from the list: the list test red; (M2) set `aria-current` instead of `aria-selected`: red; (M3) `preventDefault` on plain Home/End: red; (M4) import `ModelList` statically in the field: the lazy test red; (M5) replace `useRetryableLazy` by a bare `lazy`: `field.lazy-failure` red. Revert each.
- [ ] **Step 7:** `git commit -m "feat(web): one shared model picker list and field; session menu uses its list"`. The real-browser proof of the list inside a modal Dialog is controller step C2, run at the join (task 7).

### Task 6: Agent form and new lane use the picker

**Chain:** A-front. **Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets.

**Files:**
- Modify: `apps/web/src/features/agents/{ModelFields.tsx, use-agent-models.ts (delete), model-fields.vm.ts, AgentForm.tsx}`, `apps/web/src/features/lanes/{ModelSlots.tsx, new-lane.vm.ts, use-new-lane-data.ts, NewLaneDialog.tsx, new-lane-bed.tsx}`, their tests
- Delete: `apps/web/src/features/agents/use-agent-models.ts` and its test, `modelChoices` in `new-lane.vm.ts`, `useModelChoices` in `use-new-lane-data.ts`

**Interfaces:** `ModelFields` props become `{ model, thinking, onModel, onThinking, levels: readonly ThinkingLevel[] }`; the thinking levels follow the picked model: `ModelPickerField.onChange` gives `(model | null, summary?: PickerModel)` (task 5b); the form keeps `summary` in state to compute `levelsFor(summary)` (existing helper, unchanged). A saved model with no summary yet shows all levels the saved thinking allows, as today.
`ModelSlots` props: `{ slots, cwd, disabled, onModel, onAdd, onRemove }` (no `choices`/`truncated`); each slot renders `<ModelPickerField label=... value=... cwd={cwd} defaultLabel={t("laneNew.model.default")} .../>`.

**Rulings:** MPR4, MPR5, MPR27. The new-lane dialog and the new-agent dialog are modal `Dialog`s: the picker opens from them, which is exactly the case controller step C2 proves in a real browser (the figure of task 5b stands for it; C2 also drives the real new-lane dialog on the built app).

- [ ] **Step 1 (RED):** update/replace the tests: `ModelFields` renders the picker (no `Select` for the model; the thinking `Select` stays), opens it, calls the fake `models.available` once with `{}` (no cwd for an agent), lists only the signed-in models of the fake answer, and a fake answer holding only `anthropic` models never shows an `openai` one even if a fake `models.overview` (also installed in the test) lists it enabled: `agent-form.uses-available-not-overview`. `saved-model-stays-visible` (Review Focus 6, owner q6): an agent with model `openai/gpt-x` that the answer does not offer shows "Modèle enregistré, plus proposé" and the Save payload still carries it unchanged. New lane: `new-lane.uses-project-cwd`: each slot's field calls `models.available` with `{ cwd: projectRoot }`; adding a slot (up to 4) adds a field; a slot's default row is Pi's default (`null`); changing the project changes the cwd the next open uses. `thinking.follows-model`: picking a non-reasoning model resets a level above `off` to default, as before.
- [ ] **Step 2:** run: fail. **Step 3:** implement; remove the dead code; `pnpm knip` (no unused export). **Step 4:** `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit apps/web && pnpm knip && pnpm build && pnpm budgets`.
- [ ] **Step 5 (mutation):** (M1) put `models.overview` back in `ModelFields`: `agent-form.uses-available-not-overview` red and the scan test (task 5a) red; (M2) drop the cwd in `ModelSlots`: `new-lane.uses-project-cwd` red. Revert.
- [ ] **Step 6:** compare both renders with the chosen q1 option and boards 05 and 12 (decision 80; say so in the commit body). `git commit -m "fix(web): agent form and new lane offer Pi's available models through the shared picker"`

### Task 7: Chain A join: smoke, docs, ADR 0068, rulings, A gate, controller proof C2

**Chain:** A (the join of A-back and A-front). **Model:** Sonnet; Sonnet reviewer. **Gate:** the full gate (once, 45 min), then C2.

**Files:** Create `scripts/smoke-models.ts`, `docs/adr/0068-one-source-for-available-models.md`, `docs/research/models-batch-rulings.md` (MPR1 to MPR29 with the owner's answers, as the "Owner answers (2026-10-17)" section of this plan states them). Modify `scripts/smoke-dist.ts` (one import line and one call line; 239 lines today), `docs/agents/models.md` (a section "Which models a context may use" with the three rules, the worker's freshness (MPR25), `models.available` and its cache (the 10 s TTL, trust changes shown when it ends), the extension-model difference, the `!command` exception (MPR1), the picker; the section "Backups" of MPR29; update the "Parity" table row P07-1 proof list), `docs/agents/web.md` (the picker and Popover: one paragraph), `docs/agents/sessions.md` (one line: `sessions.models` and `set_model` call `freshAvailable`), `AGENTS.md` (one line in the topic notes: models rulings file; keep at most 150 lines).

- [ ] **Step 0 (the join, controller):** merge `a-back` and `a-front` (disjoint files; the shared whole-line files are named in the conflict scan), `pnpm install` if the lockfile moved, `pnpm build`.
- [ ] **Step 1 (smoke, MP-RT-21, the M11a I2 guard for the built helper entry):** `scripts/smoke-models.ts` exports `checkModels({ agentDir, socket })` in the style of `smoke-search.ts` and `smoke-dist.ts` calls it after the search step. It writes a plain `auth.json` key for one built-in provider into the smoke's temporary agent directory, calls `models.available` over the browser socket and asserts the list holds that provider's models and no model of an unsigned provider; calls `models.provider.get` with `{}` and asserts a 64-hex `revision`. (Task 15 extends it with the provider save.) No network: the smoke already runs under the network guard.
- [ ] **Step 2:** write the docs. ADR 0068: decision (one function, two callers, the worker re-reads before it lists, helper over pap's credential store, no commands), alternatives (daemon asks a live worker: cold-start cost and capacity; client-side filter of the overview: wrong flag; helper uses Pi's default store: runs `!command`), consequences (extension models only in sessions; the cache; a `!command` key is offered and may fail at use; the probe result of task 2; the picker's footnote).
- [ ] **Step 3 (full gate):** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm budgets && pnpm smoke`. Expected: all green; initial bundle about 228.9 KB gzip (227.4 + about 1.5); every file at most 400 lines (CI rule script). Fix what the gate finds as `fix(models): ...` commits. This is the only long hold of a heavy slot in chain A; it does not run while another plan's full gate runs.
- [ ] **Step 4 (controller step C2, BLOCKING):** run C2 (see "Controller steps") on the built app. Chain A does not merge without a green C2 and its screenshots in the ledger.
- [ ] **Step 5 (production wiring check, M11a I2):** the smoke of step 1 is the proof that the built daemon exposes `models.available`; the controller also opens the agent form on the preview after the merge: it lists only signed-in models.
- [ ] **Step 6:** `git commit -m "docs(models): one source for available models, ADR 0068 and rulings"`. The controller merges chain A to `main` after M12 and rebuilds the preview.

## Chain B: the feature

B-daemon is tasks 8, 9, 10, 13; B-web is tasks 11 and 12 (start when task 8 has landed); the tail is tasks 14 and 15 after the rebase point.

### Task 8: Provider-form contracts and the base URL check (security)

**Chain:** B-daemon. **Model:** Sonnet implementer; **Opus** reviewer (trust boundary: the base URL policy, credential rules, what a receipt keeps). **Gate:** unit.

**Files:**
- Create: `packages/contracts/src/base-url.ts`, `base-url.test.ts` (holds `BASE_URL_TABLE`), `models-provider-form.ts`, `models-provider-form.test.ts`, `credential-words.ts` (moved), `credential-words.test.ts` (moved with it)
- Modify: `packages/pi-host/src/helper/credential-words.ts` (becomes a re-export of the three names from `@pap/contracts`, so `mask.ts`, `models-json-mask.ts` and the existing test stay unchanged: the `child-env.ts` pattern), `packages/contracts/src/{models-methods.ts (spread), pi-helper.ts (3 HELPER_OPS lines), methods-idempotent.ts, methods.test.ts (or the new names file, see Global Constraints), audit.ts (2 reasons), models-login.test.ts (the reason list), index.ts}`

**Full code (security contract).** This code was run in a scratch directory under `/tmp/claude-1000/` during the plan fix (zod 4.6.5; the table below on both policy columns, 32 rows; the schemas on hostile inputs; then the scratch was deleted). The implementer types it into the files named, adds the two `defineMethod` blocks described after it, and runs the tests below.

`packages/contracts/src/base-url.ts` (the whole owner policy for plain `http:` is the one constant `HTTP_PLAINTEXT_POLICY`, owner q4, MPR9):

```ts
export const PROVIDER_FORM_LIMITS = { models: 500, headers: 8, url: 2048, name: 128 } as const;

/** One line of text with no control, bidi, zero-width or line-separator character (checked by code point). */
export function plainLine(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false;
    if (cp === 0x2028 || cp === 0x2029 || cp === 0xfeff) return false;
    if (cp >= 0x200b && cp <= 0x200f) return false;
    if (cp >= 0x202a && cp <= 0x202e) return false;
    if (cp >= 0x2066 && cp <= 0x2069) return false;
  }
  return true;
}

export type BaseUrlRefusal =
  | "too_long" | "control" | "not_a_url" | "scheme" | "credentials" | "query_or_fragment" | "host";
export type BaseUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: BaseUrlRefusal };

/** Where a plain `http:` base URL may point. */
export type HttpPlaintextPolicy = "loopback" | "any";
/**
 * THE owner policy for plain `http:` (owner q4, MPR9). `"loopback"`: this machine only. `"any"`: every host, and the
 * form warns when a key travels in clear (`keyTravelsInClear`). Flipping it is this one line plus the copy in the
 * settings-providers catalog; `BASE_URL_TABLE` already holds both columns, so its tests stay green either way.
 */
export const HTTP_PLAINTEXT_POLICY: HttpPlaintextPolicy = "loopback";

/** WHATWG normalises `0x7f.1` and `2130706433` to dotted quads, so the regex sees the real address. */
const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/**
 * `https:` to any host; `http:` as `policy` says. No credentials, query or fragment ever. The result is the origin
 * plus the path without a trailing slash (Pi appends its own paths). A host only spelled like a loopback
 * (`localhost.evil.com`, `127.0.0.1.evil.com`) is another host.
 */
export function checkBaseUrl(raw: string, policy: HttpPlaintextPolicy = HTTP_PLAINTEXT_POLICY): BaseUrlCheck {
  const fail = (reason: BaseUrlRefusal): BaseUrlCheck => ({ ok: false, reason });
  if (raw.length > PROVIDER_FORM_LIMITS.url) return fail("too_long");
  if (!plainLine(raw) || /\s/.test(raw)) return fail("control");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("not_a_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail("scheme");
  if (url.username !== "" || url.password !== "") return fail("credentials");
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#"))
    return fail("query_or_fragment");
  if (url.protocol === "http:" && policy === "loopback" && !isLoopback(url.hostname)) return fail("host");
  return { ok: true, url: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}` };
}

/** True when `baseUrl` is plain `http:` to a non-loopback host and a key (stored or env) would travel in clear. */
export function keyTravelsInClear(baseUrl: string, authKind: "stored" | "env" | "none" | "keep"): boolean {
  if (authKind === "none") return false;
  const checked = checkBaseUrl(baseUrl, "any");
  if (!checked.ok) return false;
  const url = new URL(checked.url);
  return url.protocol === "http:" && !isLoopback(url.hostname);
}
```

`packages/contracts/src/base-url.test.ts` holds the one test table. Each row is `[url, verdict under "loopback", verdict under "any"]`; the tests run every row under both policies, and run `checkBaseUrl(url)` against the column that `HTTP_PLAINTEXT_POLICY` selects. Flipping the constant to `"any"` therefore changes no test (verified in the scratch: the same table, constant flipped, green):

```ts
import { type BaseUrlRefusal, checkBaseUrl, HTTP_PLAINTEXT_POLICY, type HttpPlaintextPolicy, keyTravelsInClear } from "./base-url.ts";

type Verdict = "ok" | BaseUrlRefusal;
const bidi = String.fromCodePoint(0x202e);
const zwsp = String.fromCodePoint(0x200b);
// url, verdict under "loopback", verdict under "any"
export const BASE_URL_TABLE: ReadonlyArray<readonly [string, Verdict, Verdict]> = [
  ["https://api.example.com/v1", "ok", "ok"],
  ["https://api.example.com/v1/", "ok", "ok"],
  ["https://192.168.1.5:8443/v1", "ok", "ok"],
  ["http://localhost:11434/v1", "ok", "ok"],
  ["http://127.0.0.1:8000", "ok", "ok"],
  ["http://[::1]:8080/v1", "ok", "ok"],
  ["http://127.1.2.3", "ok", "ok"],
  ["http://0x7f.1/", "ok", "ok"],
  ["http://2130706433/", "ok", "ok"],
  ["http://192.168.1.50:11434/v1", "host", "ok"],
  ["http://gpu:11434/v1", "host", "ok"],
  ["http://ollama.local:11434/v1", "host", "ok"],
  ["http://example.com", "host", "ok"],
  ["http://169.254.169.254/latest", "host", "ok"],
  ["http://localhost.evil.com", "host", "ok"],
  ["http://127.0.0.1.evil.com", "host", "ok"],
  ["http://[::ffff:127.0.0.1]", "host", "ok"],
  ["http://0.0.0.0:11434", "host", "ok"],
  ["ftp://x", "scheme", "scheme"],
  ["file:///etc/passwd", "scheme", "scheme"],
  ["https://user:pw@api.example.com", "credentials", "credentials"],
  ["http://user@192.168.1.5", "credentials", "credentials"],
  ["https://api.example.com/v1?key=1", "query_or_fragment", "query_or_fragment"],
  ["https://api.example.com/#x", "query_or_fragment", "query_or_fragment"],
  ["https://api.example.com/?", "query_or_fragment", "query_or_fragment"],
  ["https://api.example.com/a b", "control", "control"],
  ["https://api.example.com/\t", "control", "control"],
  [`https://api.example.com/${bidi}`, "control", "control"],
  [`https://api.example.com/${zwsp}`, "control", "control"],
  [`https://${"a".repeat(2050)}.com`, "too_long", "too_long"],
  ["not a url", "control", "control"],
  ["nope", "not_a_url", "not_a_url"],
];

const verdict = (url: string, policy?: HttpPlaintextPolicy): Verdict => {
  const r = policy === undefined ? checkBaseUrl(url) : checkBaseUrl(url, policy);
  return r.ok ? "ok" : r.reason;
};
// for (const [url, loopback, any] of BASE_URL_TABLE): expect(verdict(url, "loopback")).toBe(loopback); expect(verdict(url, "any")).toBe(any);
//   expect(verdict(url)).toBe(HTTP_PLAINTEXT_POLICY === "loopback" ? loopback : any);
// plus: checkBaseUrl("http://0x7f.1/") returns url "http://127.0.0.1"; keyTravelsInClear is true for ("http://192.168.1.5:11434/v1", "stored"),
//   false for "none", false for loopback and for https.
```

`packages/contracts/src/models-provider-form.ts`:

```ts
// packages/contracts/src/models-provider-form.ts (the methods are added below this code)
import { z } from "zod";
import { checkBaseUrl, PROVIDER_FORM_LIMITS, plainLine } from "./base-url.ts";
import { credentialName } from "./credential-words.ts";

/** API types the form offers (MPR10). Each loads in Pi's own loader (helper test); the enum is the only guard against a typo. */
export const PROVIDER_API_TYPES = ["openai-completions","openai-responses","anthropic-messages","google-generative-ai","mistral-conversations"] as const;
/** The literal Pi needs to count a keyless local server as available. Not a secret. */
export const NO_KEY_LITERAL = "local-no-key";

const Revision = z.string().regex(/^[0-9a-f]{64}$/);
/** The id of a provider the form WRITES. Get and remove take any id the file holds (MP-RT-02): `AnyProviderId`. */
const ProviderId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const AnyProviderId = z.string().min(1).max(128);
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const HeaderName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
/** Headers Pi or the transport owns, plus the ones that carry a session. */
export const BANNED_HEADERS: ReadonlySet<string> = new Set([
  "host","content-length","content-type","transfer-encoding","connection","upgrade","te","trailer","proxy-authorization","cookie","set-cookie",
]);

/** A literal never starts with `!` (a command) and never holds `$` (Pi interpolates `$X` and `${X}`, MP-RT-22): use the env option. `keep` is edit only: keep the value the file already holds. */
const HeaderValue = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("literal"),
    text: z.string().min(1).max(1024).refine(plainLine, "one visible line").refine((t) => !t.startsWith("!"), "no command").refine((t) => !t.includes("$"), "env reference"),
  }).strict(),
  z.object({ kind: z.literal("env"), name: EnvName }).strict(),
  z.object({ kind: z.literal("keep") }).strict(),
]);
const Header = z.object({ name: HeaderName, value: HeaderValue }).strict();

const ModelInput = z.object({
  id: z.string().min(1).max(256).refine(plainLine, "one visible line"),
  name: z.string().max(256).refine(plainLine, "one visible line").optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).min(1).max(2).optional(),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  maxTokens: z.number().int().positive().max(10_000_000).optional(),
}).strict();

/** `stored`: the key lives in auth.json (models.setApiKey), models.json carries none. `none`: a keyless local server. `keep`: edit only. */
export const ProviderAuthInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stored") }).strict(),
  z.object({ kind: z.literal("env"), name: EnvName }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("keep") }).strict(),
]);

export const ProviderInput = z.object({
  id: ProviderId,
  name: z.string().trim().min(1).max(PROVIDER_FORM_LIMITS.name).refine(plainLine, "one visible line").optional(),
  api: z.enum(PROVIDER_API_TYPES),
  baseUrl: z.string().transform((raw, ctx) => {
    const checked = checkBaseUrl(raw);
    if (checked.ok) return checked.url;
    ctx.addIssue({ code: "custom", message: checked.reason });
    return z.NEVER;
  }),
  auth: ProviderAuthInput,
  headers: z.array(Header).max(PROVIDER_FORM_LIMITS.headers),
  models: z.array(ModelInput).max(PROVIDER_FORM_LIMITS.models),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.models.forEach((model, index) => {
    if (ids.has(model.id)) ctx.addIssue({ code: "custom", path: ["models", index, "id"], message: "duplicate" });
    ids.add(model.id);
  });
  const names = new Set<string>();
  value.headers.forEach((header, index) => {
    const lower = header.name.toLowerCase();
    const bad = BANNED_HEADERS.has(lower) || names.has(lower) || (header.value.kind === "literal" && credentialName(header.name));
    if (bad) ctx.addIssue({ code: "custom", path: ["headers", index], message: "header" });
    names.add(lower);
  });
});
export type ProviderInput = z.infer<typeof ProviderInput>;

/** `id` and `mode` ride at the top level so the receipt selector (`sensitiveParams`) binds the target (MP-RT-03). */
export const ProviderSaveParams = z.object({
  mode: z.enum(["create", "update"]),
  id: ProviderId,
  provider: ProviderInput,
  baseRevision: Revision,
}).strict().superRefine((value, ctx) => {
  if (value.id !== value.provider.id) ctx.addIssue({ code: "custom", path: ["id"], message: "id mismatch" });
  if (value.mode === "create" && (value.provider.auth.kind === "keep" || value.provider.headers.some((h) => h.value.kind === "keep")))
    ctx.addIssue({ code: "custom", path: ["provider"], message: "keep needs update" });
});
export const ProviderRemoveParams = z.object({ id: AnyProviderId, baseRevision: Revision, alsoRemoveKey: z.boolean() }).strict();
/** No `id`: only the file's revision comes back (a form opened to create a provider). */
export const ProviderGetParams = z.object({ id: AnyProviderId.optional() }).strict();
/** The form's view of one provider; a secret-looking literal is `keep`, never a value. `advanced`: the entry holds fields the form does not own. */
export const ProviderGetResult = z.union([
  z.object({ editable: z.literal(true), provider: ProviderInput, revision: Revision, advanced: z.boolean() }).strict(),
  z.object({
    editable: z.literal(false),
    reason: z.enum(["not_in_file", "builtin", "api_unsupported", "url_unsupported", "needs_raw_editor"]),
    revision: Revision,
  }).strict(),
]);
```
Methods (all `pi:admin`), declared with `defineMethod` in the same file: `models.provider.get` (`ProviderGetParams`, `ProviderGetResult`, idempotent, errors `capacity`, `timeout`, `helper_failed`, `config_invalid`, `config_path_refused`); `models.provider.save` (`ProviderSaveParams`, `sensitiveParams: ["id", "mode", "baseRevision"]`, result `ConfigSaveResult`, errors `step_up_required`, `conflict`, `not_found`, `capacity`, `timeout`, `helper_failed`, `config_invalid`, `config_path_refused`, `config_hard_link`); `models.provider.remove` (`ProviderRemoveParams`, `sensitiveParams: ["id", "baseRevision", "alsoRemoveKey"]`, same result and errors as save). The helper ops get the daemon-supplied `revisionKey` like `ConfigSaveHelperParams`. Audit reasons `provider_saved`, `provider_removed` join `PROVIDER_AUDIT_REASONS`. A `config_invalid` result carries only JSON paths (`$.file`, `$.provider.id`, `$.provider.headers[i]`, `$.providers`), never a value.

**Rulings:** MPR8, MPR9, MPR10, MPR12, MPR13, MPR20, MPR28.

- [ ] **Step 1 (RED):** `base-url.test.ts` as above (32 rows: the accepted https forms, `http://localhost:11434/v1`, `127.0.0.1`, `[::1]`, `127.1.2.3`, the normalised `0x7f.1` and `2130706433`; the refused LAN `http://192.168.1.50:11434/v1`, `gpu`, `ollama.local`, `example.com`, `169.254.169.254`, `localhost.evil.com`, `127.0.0.1.evil.com`, `[::ffff:127.0.0.1]`, `0.0.0.0`; schemes, credentials, query, fragment, a lone `?`, a space or tab, bidi and zero-width characters built from `String.fromCodePoint`, a 2050-character URL). `models-provider-form.test.ts`:
  - `ProviderInput`: id `Mine`, `-x`, `a b`, a 65-character id refused; `constructor` accepted and `__proto__` refused; an `api` of `bedrock-converse-stream` refused; 501 models refused; duplicate model ids refused at `models[1].id`; 9 headers refused; header `Host`, `content-length`, `Cookie` refused; header `X-Api-Key` with a literal refused, with `{kind:"env"}` accepted, with `{kind:"keep"}` accepted; header `X-Team` with a literal accepted; `X_Team` (underscore) accepted; a literal starting with `!` refused; a literal holding `$` (`$HOME`, `${AWS_SECRET_ACCESS_KEY}`, `a$B`) refused; a duplicate header name differing by case refused; `auth: { kind: "stored", key: "x" }` refused by `.strict()` (a key can never ride in the form); unknown top-level field refused; the LAN `baseUrl` is accepted exactly when `HTTP_PLAINTEXT_POLICY` is `"any"`.
  - `ProviderSaveParams`: `mode: "create"` with `auth: keep` refused; `id` different from `provider.id` refused; `id` missing refused. `ProviderRemoveParams` accepts the ids `Mine` and `my.local`; `ProviderGetParams` accepts `{}` and `{ id: "Mine" }`, refuses `{ id: "" }`.
  - the method table: the three new methods are `pi:admin`; `sensitiveParams` as listed; the names are in the methods test.
  - `credential-words.test.ts` moved with the module and green from the contracts package; `packages/pi-host/src/helper/credential-words.test.ts` still green through the re-export.
- [ ] **Step 2:** run: fail. **Step 3:** implement; move the credential words; add the audit reasons and update `models-login.test.ts`'s expected list; spreads and `HELPER_OPS` lines. **Step 4:** `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit packages/contracts packages/pi-host/src/helper` green.
- [ ] **Step 5 (mutation, real):** (M1) change `isLoopback` to `hostname.includes("127.0.0.1")`: the `127.0.0.1.evil.com` row goes red; (M2) delete the `credentials` check: the `user:pw` rows red; (M3) drop `.strict()` on `ProviderAuthInput.stored`: the `key` rider case red; (M4) drop the `credentialName` clause: the `X-Api-Key` literal case red; (M5) make `plainLine` skip `0x2066..0x2069`: the bidi row red; (M6) make `checkBaseUrl` ignore `policy` and always allow `http:`: the `loopback` column red; (M7) delete the `$` refinement: the `$HOME` case red; (M8) drop the `id !== provider.id` check: the mismatch case red. Revert each; list outcomes in the commit body.
- [ ] **Step 6:** `git commit -m "feat(contracts): provider form schemas, base URL policy and credential words in contracts"`

### Task 9: Helper ops `models.provider.get|save|remove` (security)

**Chain:** B-daemon. **Model:** Sonnet implementer; **Opus** reviewer (rewrites a credential-adjacent file; unknown-field preservation; what `get` may return). **Gate:** unit + int (helper pool).

**Files:**
- Create: `packages/pi-host/src/helper/ops/provider-apply.ts` (pure edit functions), `provider-apply.test.ts`, `provider-view.ts` (the file-to-form view, below), `provider-view.test.ts`, `models-provider.ts` (the three ops), `models-provider.test.ts`, `models-provider.write.test.ts`, `models-json-shared.ts` (pure move of `revisionOf`, `location`, `refused`, `readCurrent`, `piRejects`, `providersOf`, `fullyEnabled`, `resync` out of `models-json.ts`, re-imported there so its 400-line test file is untouched)
- Modify: `packages/pi-host/src/helper/ops/models-json.ts` (imports from the shared file; behaviour identical), `packages/pi-host/src/helper/ops.ts` (3 registry lines)

**Full code (security contract): the pure edit and the view.** Both were run in a scratch directory under `/tmp/claude-1000/` during the plan fix (comments and trailing commas, a 17-digit integer, unknown-field preservation, a `$` literal; the view on a LAN URL, a query URL, an uppercase id, an `X_Foo` header, an `audio` input, an unknown api and a rich entry with secrets), then deleted.

```ts
// packages/pi-host/src/helper/ops/provider-apply.ts
import { credentialName, MODELS_LIMITS, NO_KEY_LITERAL, type ProviderInput } from "@pap/contracts";
import { stripBom } from "../jsonc.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const STRINGS = /"(?:[^"\\\n]|\\.)*"/g;

export type Applied =
  | { readonly text: string }
  | { readonly issues: readonly string[] }
  | { readonly fail: "conflict" | "not_found" };

/** Strict JSON only (MPR11): a comment or a trailing comma would be dropped by a rewrite, and an integer of 16 or more digits would lose precision. */
export function parseStrict(text: string): Json | null {
  const clean = stripBom(text);
  if (/\d{16,}/.test(clean.replace(STRINGS, '""'))) return null;
  try {
    const value: unknown = JSON.parse(clean);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const OWNED_MODEL_FIELDS = ["name", "reasoning", "input", "contextWindow", "maxTokens"] as const;
const envRef = (name: string): string => `$${name}`;

export function applyProvider(
  current: string | null,
  input: ProviderInput,
  mode: "create" | "update",
  builtin: ReadonlySet<string>,
): Applied {
  if (builtin.has(input.id)) return { issues: ["$.provider.id"] };
  let root: Json = { providers: {} };
  if (current !== null) {
    const parsed = parseStrict(current);
    if (parsed === null) return { issues: ["$.file"] }; // needs_raw_editor: the caller words it
    root = parsed;
  }
  if (root.providers === undefined) root.providers = {};
  const providers = root.providers;
  if (!isObject(providers)) return { issues: ["$.providers"] };
  const existing = Object.hasOwn(providers, input.id) ? providers[input.id] : undefined;
  if (mode === "create" && existing !== undefined) return { fail: "conflict" };
  if (mode === "update" && !isObject(existing)) return { fail: "not_found" };
  if (mode === "create" && Object.keys(providers).length >= MODELS_LIMITS.providers)
    return { issues: ["$.providers"] };

  const entry: Json = isObject(existing) ? { ...existing } : {};
  const issues: string[] = [];

  if (input.name === undefined) delete entry.name;
  else entry.name = input.name;
  entry.api = input.api;
  entry.baseUrl = input.baseUrl;

  switch (input.auth.kind) {
    case "stored":
      delete entry.apiKey;
      break;
    case "env":
      entry.apiKey = envRef(input.auth.name);
      break;
    case "none":
      entry.apiKey = NO_KEY_LITERAL;
      break;
    case "keep":
      break;
  }

  const old = isObject(entry.headers) ? entry.headers : {};
  const headers: Record<string, string> = {};
  input.headers.forEach((header, index) => {
    const at = `$.provider.headers[${index}]`;
    switch (header.value.kind) {
      case "literal":
        // The schema guards too; the op guards independently (a `$` is interpolated by Pi, a `!` is a command).
        if (credentialName(header.name) || header.value.text.includes("$") || header.value.text.startsWith("!")) issues.push(at);
        else headers[header.name] = header.value.text;
        break;
      case "env":
        headers[header.name] = envRef(header.value.name);
        break;
      case "keep": {
        const prior = Object.hasOwn(old, header.name) ? old[header.name] : undefined;
        if (typeof prior === "string") headers[header.name] = prior;
        else issues.push(at);
        break;
      }
    }
  });
  if (input.headers.length === 0) delete entry.headers;
  else entry.headers = headers;

  const oldModels = new Map<string, Json>();
  if (Array.isArray(entry.models))
    for (const model of entry.models) if (isObject(model) && typeof model.id === "string") oldModels.set(model.id, model);
  const models = input.models.map((model) => {
    const merged: Json = { ...(oldModels.get(model.id) ?? {}), id: model.id };
    for (const key of OWNED_MODEL_FIELDS) {
      if (model[key] === undefined) delete merged[key];
      else merged[key] = model[key];
    }
    return merged;
  });
  if (models.length === 0) delete entry.models;
  else entry.models = models;

  if (issues.length > 0) return { issues };
  providers[input.id] = entry;
  return { text: `${JSON.stringify(root, null, 2)}\n` };
}

/** Removes `providers[id]` only; every other byte of meaning stays. */
export function removeProvider(current: string, id: string, builtin: ReadonlySet<string>): Applied {
  if (builtin.has(id)) return { issues: ["$.provider.id"] };
  const root = parseStrict(current);
  if (root === null) return { issues: ["$.file"] };
  const providers = root.providers;
  if (!isObject(providers) || !Object.hasOwn(providers, id)) return { fail: "not_found" };
  delete providers[id];
  return { text: `${JSON.stringify(root, null, 2)}\n` };
}
```
`packages/pi-host/src/helper/ops/provider-view.ts` (the form's view of a provider the file holds; MP-RT-02):

```ts
import { checkBaseUrl, credentialName, NO_KEY_LITERAL, PROVIDER_API_TYPES, ProviderInput } from "@pap/contracts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const ENV_REF = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]{0,63})\}|([A-Za-z_][A-Za-z0-9_]{0,63}))$/;
export const OWNED_PROVIDER_KEYS: ReadonlySet<string> = new Set(["name", "api", "baseUrl", "apiKey", "headers", "models"]);
export const OWNED_MODEL_KEYS: ReadonlySet<string> = new Set(["id", "name", "reasoning", "input", "contextWindow", "maxTokens"]);

export type ViewOutcome =
  | { readonly editable: true; readonly provider: ProviderInput; readonly advanced: boolean }
  | { readonly editable: false; readonly reason: "api_unsupported" | "url_unsupported" | "needs_raw_editor" };

const authOf = (apiKey: unknown): unknown => {
  if (apiKey === undefined) return { kind: "stored" };
  if (apiKey === NO_KEY_LITERAL) return { kind: "none" };
  if (typeof apiKey !== "string") return { kind: "keep" };
  const env = ENV_REF.exec(apiKey);
  return env ? { kind: "env", name: env[1] ?? env[2] } : { kind: "keep" };
};

/**
 * The form's view of a provider the file holds (MP-RT-02). Built from the file, so a secret-looking literal is `keep` and
 * never a value. Anything outside the form's grammar (an unknown api, a URL the policy refuses, an odd header name, an
 * `input` the form lacks) is `editable: false` with a reason, never an error and never a path or a value.
 */
export function viewOf(id: string, entry: unknown): ViewOutcome {
  if (!isObject(entry)) return { editable: false, reason: "needs_raw_editor" };
  if (!PROVIDER_API_TYPES.includes(entry.api as never)) return { editable: false, reason: "api_unsupported" };
  if (typeof entry.baseUrl !== "string") return { editable: false, reason: "needs_raw_editor" };
  if (!checkBaseUrl(entry.baseUrl).ok) return { editable: false, reason: "url_unsupported" };
  const headers: unknown[] = [];
  if (entry.headers !== undefined) {
    if (!isObject(entry.headers)) return { editable: false, reason: "needs_raw_editor" };
    for (const [name, value] of Object.entries(entry.headers)) {
      if (typeof value !== "string") return { editable: false, reason: "needs_raw_editor" };
      const env = ENV_REF.exec(value);
      headers.push({
        name,
        value: env ? { kind: "env", name: env[1] ?? env[2] } : credentialName(name) ? { kind: "keep" } : { kind: "literal", text: value },
      });
    }
  }
  const rawModels: unknown[] = entry.models === undefined ? [] : Array.isArray(entry.models) ? entry.models : [null];
  const models = rawModels.map((model) => {
    if (!isObject(model)) return null;
    const { id: modelId, name, reasoning, input, contextWindow, maxTokens } = model;
    return { id: modelId, name, reasoning, input, contextWindow, maxTokens };
  });
  const parsed = ProviderInput.safeParse({
    id, name: entry.name, api: entry.api, baseUrl: entry.baseUrl, auth: authOf(entry.apiKey), headers, models,
  });
  if (!parsed.success) return { editable: false, reason: "needs_raw_editor" };
  const advanced =
    Object.keys(entry).some((key) => !OWNED_PROVIDER_KEYS.has(key)) ||
    rawModels.some((model) => isObject(model) && Object.keys(model).some((key) => !OWNED_MODEL_KEYS.has(key)));
  return { editable: true, provider: parsed.data, advanced };
}
```

**The ops** (`models-provider.ts`), each `defineOp` with the contract params:
- `get` (params `{ id?, revisionKey }`): read the file (`readCurrent`) and take its `revision`; no `id` -> `{ editable: false, reason: "not_in_file", revision }` (a form opened to create). A file that is present but fails `parseStrict` (comments, a trailing comma, a long integer, not an object) -> `{ editable: false, reason: "needs_raw_editor", revision }` for every id (MPR11). Id absent from `providers` -> `not_in_file`; a built-in id -> `builtin`; else `viewOf(id, providers[id])`: `editable: true` with `provider` and `advanced`, or `editable: false` with the reason `viewOf` gave (`api_unsupported`, `url_unsupported`, `needs_raw_editor`). The view is built from the file, so a stored literal secret is never in the answer; only a reason leaves for a provider the form cannot edit. The daemon parses the answer with `ProviderGetResult`.
- `save`: params + `revisionKey`; read current; `revisionOf` must equal `baseRevision` else `HelperOpError("conflict")`; `applyProvider(...)` (builtin set from `builtinProviders()` of `pi-ai/providers/all`); `{ fail }` throws `conflict`/`not_found`; `{ issues }` returns `config_invalid` with the paths (fixed phrases only; the `$.file` issue is the comments/long-integer refusal and the UI words it, MPR11); `piRejects(text, ctx)` on the candidate (Pi's own loader, private copy) returns `invalid(["$"])` on error; `fullyEnabled` before; revision re-check right before the write; `writePiFile(path, text, { roots, mode: 0o600, keepMode: false, onFolderSyncFailed })`; `resync`; return `{ revision, enabledModelsSynced }`. (Pi 1.1.0 loads a provider with an unknown `api`, so there is no loader-based API check: the zod enum is the guard, MPR10.)
- `remove`: params `{ id, baseRevision, revisionKey }`; the same revision rules; `removeProvider` for any non-built-in id the file holds (including an uppercase or dotted id and a provider the form cannot edit); a comments file -> `config_invalid` `$.file`; the stored key is removed by the daemon (task 10), not here.

**Rulings:** MPR8, MPR10 to MPR14, MPR20, MPR28.

- [ ] **Step 1 (RED), pure:** `provider-apply.test.ts`:
  - `save.keeps-unknown-fields` (Review Focus 4): a file with provider `mine` holding `compat`, `modelOverrides`, `authHeader`, and models carrying `cost`, `thinkingLevelMap`, `compat`; updating `name`, `baseUrl` and one model's `maxTokens` leaves every other key deep-equal (compare parsed JSON of before and after, key by key).
  - `save.other-providers-untouched`: provider `other` is deep-equal after the edit.
  - `save.model-merge-by-id`: reordering models keeps each model's unknown fields; a removed model disappears; a new model has only owned fields.
  - `save.unset-owned-fields`: a model whose `name` is omitted loses `name` but keeps `cost`.
  - `save.refuses-comments` (Review Focus 5): text with `// c`, `/* c */` or a trailing comma returns `issues: ["$.file"]` and the input text is not changed; `save.refuses-long-integer`: `"maxRequestBytes": 12345678901234567` refused; a 17-digit number inside a string is accepted.
  - `save.auth`: `stored` removes `apiKey`; `env` writes `$NAME`; `none` writes `NO_KEY_LITERAL`; `keep` leaves a `!command` apiKey byte for byte; `create` with an existing id is `fail: "conflict"`; `update` of a missing id `not_found`; a built-in id refused; the 301st provider refused.
  - `save.headers`: env writes `$NAME`; literal for `X-Team` kept; literal for `X-Api-Key` is an issue (also guarded in the schema; the op guards independently); `keep` copies the existing value and an unknown name is an issue.
  - `save.prototype-keys`: ids `constructor` and `toString` are written as ordinary own keys and read back; `Object.prototype` is not polluted (`({} as any).polluted === undefined` after a `__proto__` header attempt is impossible by schema; the test feeds a parsed file whose JSON contains `"__proto__": {"polluted": true}` and asserts the edit neither reads nor copies it into `Object.prototype`).
  - `remove`: removes only that provider; a missing id `not_found`.
- [ ] **Step 2 (RED), ops** (`makeModelsBed`, `PI_OFFLINE=1`, `blockedAttempts` empty): `provider.get` view tests (secret literal `apiKey: "sk-LITERAL"` appears as `keep`, the string is not in the serialised answer, nor are the header literals `X-Api-Key: sk-HDR`; `get.comments-file` (Review Focus 5): a file with a `//` comment or a trailing comma answers `needs_raw_editor` for every id and `get` with no id answers `not_in_file` with a revision on a missing or a plain file; a built-in id `builtin`; `advanced` true/false; `get.degrades.*` (Review Focus 10, MP-RT-02): a LAN `http://192.168.1.5:11434/v1` provider answers `editable:false, reason:"url_unsupported"` under the loopback policy, a `?api-version=` URL `url_unsupported`, an uppercase id `Mine` and a dotted id `my.local` `needs_raw_editor`, an `X_Foo` header name is editable, an `input` of `audio` `needs_raw_editor`, `api: "bogus"` `api_unsupported`, and every one of these answers parses with the daemon's `ProviderGetResult` (never `helper_failed`); `remove.any-id`: `remove` deletes `Mine`, `my.local` and the LAN provider, and answers `not_found` for an absent id and `config_invalid` `$.provider.id` for a built-in); `provider.save` end to end on a temp file: creates the file when missing (mode 0600, `statSync(...).mode & 0o777 === 0o600`), conflict on a stale revision, conflict when the file changed between read and write (use the existing resync-race helper of `models-json.test.ts` as the model), result `revision` equals a fresh `models.config.get` revision, `enabledModelsSynced`: with `enabledModels: ["mine/*"]` in settings and a model added the pattern still covers it; a saved provider for **each** of `PROVIDER_API_TYPES` loads in Pi's loader (`runtime.getModels(id)` non-empty, every `model.api === value`) (`save.each-api-type-loads`); `save.comments-file`: `save` and `remove` on a commented file answer `config_invalid` with exactly `["$.file"]` and leave the file byte for byte; a hard-linked `models.json` is refused `config_hard_link`; a symlink to `/etc/x` refused `config_path_refused`; a `!touch marker` `apiKey` kept with `keep` is not run by the save (marker absent); output file ends with a newline and parses as strict JSON.
- [ ] **Step 3:** run: fail. **Step 4:** implement; do the pure move to `models-json-shared.ts` first and run `models-json*.test.ts` green before adding the new code. **Step 5:** `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit packages/pi-host/src/helper` green; helper pool int file green.
- [ ] **Step 6 (mutation, real):** (M1) replace the model merge by building `{ id, ...owned }` only: `save.keeps-unknown-fields` red; (M2) use `parseJsonc` instead of `parseStrict` and re-serialise: `save.refuses-comments` red; (M2b) change the digits rule `\d{16,}` to `\d{17,}`: `save.refuses-long-integer` red (a 16-digit integer case is in the test); (M2c) in `get`, skip the `ProviderInput.safeParse` inside `viewOf` and return the raw view: the `get.degrades.*` cases red (the daemon's schema parse fails); (M3) skip `piRejects`: an invalid candidate (a model with `contextWindow` of the wrong type injected through a hand-built `ProviderInput` cast) reaches the write: the "Pi rejects" test red; (M4) skip the second revision check: the race test red; (M5) delete the `credentialName` guard in `applyProvider`: the op-level header test red even though the schema guards too; (M6) write with `mode: 0o644`: the mode test red; (M7) make `remove` use the strict `ProviderId` regex: `remove.any-id` red. Revert each.
- [ ] **Step 7:** `git commit -m "feat(models): provider get, save and remove helper ops with a field-preserving models.json merge"`

### Task 10: Daemon provider methods: step-up, audit, key flow (security)

**Chain:** B-daemon. **Model:** Sonnet implementer; **Opus** reviewer (credential flow end to end, no secret anywhere). **Gate:** unit + int.

**Files:**
- Create: `apps/daemon/src/modules/models/provider-config.ts`, `provider-config.test.ts`, `provider-config.int.test.ts`
- Modify: `apps/daemon/src/modules/models/{service.ts (compose, at most 8 lines), rpc.ts, index.ts}`, `apps/daemon/src/compose-pi.test.ts`, `packages/contracts/src/methods.test.ts`

**Interfaces:**
```ts
// provider-config.ts: created from the same deps as the service; composed in service.ts
export function createProviderConfig(deps: {
  run: Run; serialised: <T>(task: () => Promise<T>) => Promise<T>; revisionKey: string; clock: Clock;
  audit: (caller: Caller, reason: "provider_saved" | "provider_removed", detail: Record<string, string>) => void;
  invalidate: () => void; logSaveEvent: (event: unknown) => void;
}): {
  get(caller: Caller, params: { id?: string }): Promise<ProviderGetResult>; // no id: the file's revision for a form that creates
  save(caller: Caller, params: ProviderSaveParams): Promise<ConfigSaveResult>;
  remove(caller: Caller, params: ProviderRemoveParams): Promise<ConfigSaveResult>;
};
```
`save`: `requireStepUp(caller, clock.now())` first; `serialised(() => run("models.provider.save", { ...params, revisionKey }, WRITE_DEADLINE_MS, undefined, logSaveEvent))`; `invalidate()` always; audit `provider_saved {provider: id}` only on a `revision` result. `remove`: step-up; one queue slot runs the op and, when `alsoRemoveKey`, `auth.logout` inside the same `serialised` callback so the two cannot interleave with another write; audit `provider_removed {provider}` and, if the key was removed, the existing `provider_signed_out {provider}`. `get`: `run("models.provider.get", { ...(id === undefined ? {} : { id }), revisionKey }, READ_DEADLINE_MS)`; no step-up, no audit. The UI keeps the `revision` it returns as the `baseRevision` of the later save or remove (MPR8); the daemon never fetches one for it.
Order for adding a provider with a stored key (the UI drives it): `models.provider.save` then `models.setApiKey` (existing; step-up window is shared, MC: one password entry per 5 minutes).

**Rulings:** MPR8, MPR12, MPR14, MPR21.

- [ ] **Step 1 (RED), unit:** a token caller gets `forbidden` on all three methods (`security/pi-token.test.ts` gains the three names, in the style of the existing rows); a session caller without step-up gets `step_up_required` on save and remove and the fake helper is never run (`save.step-up-first`); `get` needs none; a stale-revision `conflict` passes through; a `config_invalid` result is returned as a result and is not audited; a success audits exactly `{ reason: "provider_saved", detail: { provider } }` and nothing else (no URL, no header, no model); `remove` with `alsoRemoveKey` runs `models.provider.remove` then `auth.logout` in one queue slot (order assertion with a fake pool) and audits both; every method clears the available cache (`provider.invalidates-available`); `save.replay-other-target` (Review Focus 11, MP-RT-03): the same command id with another `id` or another `mode` is `bad_request` (`sensitiveParams` is `["id","mode","baseRevision"]`, so the receipt selector binds the target), and the same id, mode and revision with another `provider` body returns the receipt of the first, stated in the test name (`replay-same-target-returns-first`); `remove` likewise with `["id","baseRevision","alsoRemoveKey"]`; `remove` of a provider the form cannot edit (uppercase id) works for a browser caller.
- [ ] **Step 2 (RED), int** (real helper pool, temp agent dir, network guard, capture logger, the daemon's real audit/receipt tables as `service.int.test.ts` does): save then `setApiKey` with the marker key `sk-test-MARKER-<random>`; then assert the marker occurs **nowhere**: not in `models.json`, not in the logger's captured lines (messages and fields), not in any audit row (`SELECT * FROM audit` serialised), not in the receipts table (`SELECT` of the command receipt rows), not in the result JSON of `models.provider.get`, `models.config.get`, `models.overview`, `models.available`, not in the helper's stderr capture; it occurs exactly once, in `auth.json`, whose mode is 0600 (`key.marker.nowhere`). A header literal for `X-Team` in the request appears in `models.json` and in no log or audit line. A save with `auth: {kind:"env", name:"FOO"}` writes `$FOO` and the process env value of `FOO` is never read into any result.
- [ ] **Step 3:** run: fail. **Step 4:** implement, compose, add the rpc entries and the `compose-pi.test.ts` method names (production wiring: the handler table is built by `createModelsModule`; the test calls it that way). **Step 5:** `pnpm lint && pnpm typecheck`; unit + the three int files green.
- [ ] **Step 6 (mutation):** (M1) move `requireStepUp` after the run: `save.step-up-first` red; (M2) put `params.provider` into the audit detail: the audit-shape test red (and the marker test if a header carries it); (M3) drop `id` from `sensitiveParams`: `save.replay-other-target` red; drop `sensitiveParams` altogether: the receipt-shape test red; (M4) drop `invalidate()`: `provider.invalidates-available` red. Revert.
- [ ] **Step 7:** `git commit -m "feat(models): daemon provider save and remove with step-up, audit and cache invalidation"`

### Task 11: Provider form UI: list, fields, presets, validation

**Chain:** B-web (starts when task 8 has landed; it needs the contracts and fakes only). **Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets.

**Files:**
- Create: `apps/web/src/features/models/provider/{ProviderForm.tsx, ProviderFields.tsx, ModelRows.tsx, HeaderRows.tsx, presets.ts, provider-form.vm.ts, use-provider-form.ts, index.ts}` and tests; `apps/web/src/i18n/catalog/settings-providers.ts` + `register-settings-providers.ts`
- Modify: `apps/web/src/features/models/ProviderList.tsx` (an "Add a provider" button; models.json providers get "Edit"), `ModelsSection.tsx` (mount the form through `LazyBoundary` and `useRetryableLazy`, at most 6 lines), `apps/web/src/i18n/index.ts` and `catalog-keys.test.ts` (one whole line each)

**Interfaces:**
```ts
// provider-form.vm.ts
export interface Draft { id: string; name: string; api: ProviderApi; baseUrl: string; auth: AuthDraft; headers: HeaderDraft[]; models: ModelDraft[] } // no key: the form holds none (MPR12)
export const emptyDraft = (preset?: Preset): Draft;
export function toInput(draft: Draft): ProviderInput;            // the exact object sent
export function problems(draft: Draft, existingIds: ReadonlySet<string>, builtinIds: ReadonlySet<string>): Problems; // client-side mirror: uses checkBaseUrl and ProviderInput.safeParse, the same code as the server
// presets.ts: [{ key: "ollama", api: "openai-completions", baseUrl: "http://localhost:11434/v1", auth: "none" }, lmstudio (http://localhost:1234/v1, none), vllm (http://localhost:8000/v1, none), openrouter (https://openrouter.ai/api/v1, stored), openai-compatible (blank, stored), anthropic-compatible (blank, stored), gemini-compatible (blank, stored), custom]
```
Presets only prefill form fields; none is a Pi concept (owner q2: presets first, then one short form). The form: preset cards first, then sections Connection (name, id, API type, base URL with the policy shown as text chosen by `HTTP_PLAINTEXT_POLICY` and the refusal reason in words; under `"any"` also the `keyTravelsInClear` warning when the auth is `stored` or `env`), Authentication (`stored`: a note "Vous saisirez la clé après l'enregistrement" and no input; `env`: a variable name field; `none`: note), Headers (rows, env toggle, credential-name rows locked to env with a one-line reason; a literal containing `$` shows the "utilisez une variable d'environnement" reason), Models (rows; the "Discover" button arrives in task 12; manual add), Advanced note when `advanced` (edit). Buttons Save and Cancel; unsaved-changes guard reuses `DiscardConfirm`. **There is no key field and no `type="password"` input in this form** (MP-RT-10): after a successful save of a `stored` provider, task 12 offers the existing `ApiKeyForm`.

**Opening.** The form opens with `models.provider.get`: `{}` for a new provider, `{ id }` for an edit; the `revision` it returns is kept for the save (task 12). Results: `editable: true` fills the draft; `editable: false` shows one sentence by `reason` and no form fields: `needs_raw_editor` ("Ce fichier contient des commentaires ou des virgules finales, ou ce fournisseur utilise des réglages que le formulaire ne couvre pas : modifiez-le dans l'éditeur brut"), `url_unsupported` ("L'adresse de ce fournisseur n'est pas acceptée par le formulaire (http: hors de cette machine) : éditeur brut"), `api_unsupported`, `builtin`, each with a link to the raw editor; a commented file also disables "Add a provider" with the same sentence. `unknown_method` or a stale chunk shows the "rechargez la page" message (Global Constraints).

**Rulings:** MPR9, MPR11, MPR12, MPR20, MPR22, MPR24.

- [ ] **Step 1 (RED):** vm tests: `toInput` is accepted by `ProviderInput.safeParse` for each preset with a model added; `problems` reports `baseUrl.host` for `http://192.168.1.50:11434` (while the policy is `"loopback"`; the test reads the verdict from `BASE_URL_TABLE`'s column so a flip does not break it), `baseUrl.credentials` for a URL with `user:pw@`, `id.builtin` for `anthropic`, `id.exists` on create, `models.limit` at 501 rows, `headers.credential` for a literal `X-Api-Key`, `headers.dollar` for a literal with `$`; every problem key has a French and an English message (catalog completeness test, as the other catalogs have) and the French accent test of Global Constraints. Component tests: preset cards render; picking Ollama prefills and sets auth `none`; `form.has-no-password-input`: no `input[type=password]` and no `autocomplete="new-password"` anywhere in the form, for every auth kind; the base URL policy sentence is visible text, not a tooltip, and is the one for `HTTP_PLAINTEXT_POLICY`; the credential-name header row offers only env; Save is disabled while problems exist; on `config_invalid` issues the matching fields show the fixed phrase; edit mode loads `models.provider.get`, shows the "advanced settings kept" note when `advanced`; `form.not-editable.*` (MP-RT-02, MP-RT-18): each `editable: false` reason shows its sentence, the raw-editor link and no fields; a `models.json` with comments disables "Add a provider" with the comments sentence; phone layout (`useIsPhone`) stacks the sections and keeps 44 px controls.
- [ ] **Step 2:** run: fail. **Step 3:** implement; all files at most 400 lines (split rows into their own files as listed). Compare the render with the chosen q2 option of the owner page and board 08 (decision 80; say so in the commit body). **Step 4:** `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit apps/web && pnpm build && pnpm budgets` (the form is lazy: eager delta under 0.3 KB, i.e. the lazy boundary at the Settings > Models section is kept).
- [ ] **Step 5 (mutation):** (M1) add an `<input type="password">` to the authentication section: `form.has-no-password-input` red; (M2) skip `checkBaseUrl` in `problems`: the host case red; (M3) show the loopback sentence unconditionally: the policy-sentence test red under a flipped constant (the test mocks the constant); (M4) render the form fields for `editable: false`: `form.not-editable.*` red. Revert.
- [ ] **Step 6:** `git commit -m "feat(web): provider form with presets, validation and no key field"`

### Task 12: Form flows: save, key, discover import, remove

**Chain:** B-web. **Model:** Sonnet; Sonnet reviewer (the key is no longer in this form; the existing `ApiKeyForm` carries it). **Gate:** unit + build + budgets.

**Files:** Create `apps/web/src/features/models/provider/{use-provider-save.ts, DiscoverImport.tsx, RemoveProvider.tsx}` and tests. Modify `ProviderForm.tsx`, `ProviderDetail.tsx` (a "Test" per model already exists in `ModelTest.tsx`; reuse), `ModelsSection.tsx` (reload the overview after save and remove).

**Flow (`use-provider-save.ts`):**
1. the `revision` is the one `models.provider.get` returned when the form opened (task 11); the hook never calls `models.config.get`, so a change made between open and Save (the raw editor, another tab) is a `conflict`, not a silent overwrite (MP-RT-03);
2. `models.provider.save` through the existing `StepUpRunner` (`features/models/step-up.ts`) so the password prompt appears once, with `{ mode, id, provider, baseRevision }`;
3. on success: reload `models.provider.get` (new revision) and the overview; if `auth.kind === "stored"`, show "Fournisseur enregistré. Ajoutez la clé" with the existing `ApiKeyForm` for that provider id (already step-up, empties itself, `autoComplete="off"`; a Skip button leaves the provider without a key). The key never passes through this hook or this form;
4. `conflict`: reload with `models.provider.get`, keep the draft, show "Le fichier a changé ; vérifiez puis enregistrez de nouveau";
5. `config_invalid` with `$.file`: the comments sentence of task 11 (MPR11); other issue paths map to fields;
6. `unknown_method` or a stale chunk: the "rechargez la page" message, nothing sent twice.

**Discover:** after a provider is saved (discover needs a saved provider: it reads the file), the button "Discover models" calls `models.discover { provider }` (step-up as today), lists the result (id, context, reasoning) with checkboxes, at most 500 importable (the rest is shown disabled with the cap text), and fills `models` rows in the form (the owner saves again). The existing `DiscoverPanel.tsx` is reused if its props fit; otherwise the import list is new and `DiscoverPanel` stays for the detail pane. **Remove:** a confirm dialog naming the provider, with the checkbox "Also remove the stored key" unticked by default, then `models.provider.remove { id, baseRevision, alsoRemoveKey }` (works for a provider the form cannot edit, MPR8).

**Rulings:** MPR8, MPR11, MPR12, MPR14, MPR15, MPR20.

- [ ] **Step 1 (RED):** hook tests with a fake runtime: call order `provider.get` (at open) -> `provider.save` (no `config.get` anywhere: `save.revision-from-get`) -> `ApiKeyForm` offered for `stored`; `save.conflict-reloads`: the fake answers `conflict`, the hook calls `provider.get` again, keeps the draft and shows the message; `key.marker.nowhere` (web side): a marker typed into the `ApiKeyForm` after a save is sent only in `models.setApiKey` params (no other call's params contain it), and after submit, failure and unmount it is in no DOM `value`, no `localStorage` key or value, no `sessionStorage`, no `window.history.state` and no rendered text; the provider form itself never holds it (`form.has-no-password-input` of task 11); step-up cancelled -> nothing sent; `config_invalid` `$.file` shows the comments sentence; `unknown_method` shows the reload message; `discover` result with 600 models imports at most 500 and says why; discover is disabled before the first save with the reason; remove asks, defaults the key checkbox off, passes `alsoRemoveKey` correctly, works for an id the form cannot edit, and reloads. Sign-out: the form unmounts with the settings tree; a test mounts the form and the `ApiKeyForm`, types a marker, unmounts via the app's sign-out reset, remounts: empty.
- [ ] **Step 2:** run: fail. **Step 3:** implement. **Step 4:** `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit apps/web && pnpm knip && pnpm build && pnpm budgets`.
- [ ] **Step 5 (mutation):** (M1) call `models.config.get` for the revision instead of using the opened one: `save.revision-from-get` red; (M2) skip the reload on `conflict`: `save.conflict-reloads` red; (M3) remove the 500 cap: the cap test red; (M4) pass the draft's typed marker into `provider.save` params (add a key field to the call): the key-only-in-setApiKey test red. Revert.
- [ ] **Step 6:** compare the flows with the chosen q2 option (decision 80); `git commit -m "feat(web): provider save, key, discover import and remove flows"`

### Task 13: Extension providers, read-only (contract, helper op, daemon)

**Chain:** B-daemon. **Model:** Sonnet; **Opus** reviewer (runs the owner's extension code on a click). **Gate:** unit + int.

**Files:** Create `packages/contracts/src/models-extensions.ts` + test, `packages/pi-host/src/helper/ops/models-extensions.ts` + tests, `apps/daemon/src/modules/models/extensions.ts` + test. Modify (additive) `models-methods.ts`, `pi-helper.ts`, `ops.ts`, `rpc.ts`, `service.ts` (compose), `methods-idempotent.ts`, `methods.test.ts`, `compose-pi.test.ts`.

**Interfaces:**
```ts
export const ExtensionProviders = z.object({
  providers: z.array(z.object({ id: z.string().min(1).max(128), name: z.string().max(256), models: z.array(ModelSummary).max(500), modelsTruncated: z.boolean() }).strict()).max(MODELS_LIMITS.providers),
  /** An extension failed to load; nothing was guessed (fail closed, as models.usage). */
  failed: z.boolean(),
}).strict();
// "models.extensions": pi:admin, idempotent true, params {}, result ExtensionProviders; errors capacity, timeout, helper_failed, config_invalid, config_path_refused
// HELPER_OPS["models.extensions"]
```
The op reuses the loader `models-usage.ts` uses (`open` of `UsageDeps`: global `extensions/` and enabled packages of the global settings, offline with `PI_OFFLINE` on, `projectTrusted: false`, no project scope) and returns the providers the extensions registered (`runtime.getRegisteredProviderIds()` and their models), never the built-in or `models.json` ones, never a base URL or header. No step-up (like `models.usage`: an explicit click, a read); `pi:admin` so a token cannot trigger extension code (the page says "runs your global extensions").

**Rulings:** MPR17.

- [ ] **Step 1 (RED):** op tests with a fixture extension in the temp agent dir that registers provider `ext1` with two models (the `models-usage.extensions.test.ts` fixture style): answers it with `models`; a throwing extension gives `failed: true` and no guess; a project's `.pi/extensions` is not loaded (untrusted and trusted project cases); no network (`blockedAttempts` empty); the answer has no `baseUrl`, header or key (strict schema + a marker `apiKey` in the extension's config is absent); a token caller is `forbidden`.
- [ ] **Step 2:** run: fail. **Step 3:** implement; **Step 4:** `pnpm lint && pnpm typecheck`, unit + int green. **Step 5 (mutation):** load the project scope in the op: the project-extension test red; revert.
- [ ] **Step 6:** `git commit -m "feat(models): read-only list of the providers extensions register"`

### Rebase point (controller)

After M12, chain A and M6b have merged (if M6b is late: after A, and once more, mechanically, after M6b): `git fetch`, combine B-daemon and B-web, `git rebase main` on `feat/models-picker-providers`, resolve the whole-line conflicts named in the conflict scan (`models-methods.ts`, `pi-helper.ts`, `ops.ts`, `methods.test.ts`, `compose-pi.test.ts`, `i18n/index.ts`, `catalog-keys.test.ts`, `FormFigures.tsx`), `pnpm install` if the lockfile moved, `pnpm build`, then dispatch task 14. The line budgets are recounted here (`methods.test.ts`: new names into `models-methods-names.test.ts` if the file would pass 395; `AGENTS.md` at most 150 lines).

### Task 14: Availability view and extension list (UI)

**Chain:** B tail (after the rebase point). **Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets.

**Files:** Create `apps/web/src/features/models/availability/{AvailabilitySection.tsx, ModeSwitch.tsx, ProviderRows.tsx, Preview.tsx, ExtensionProviders.tsx, availability.vm.ts, use-availability.ts, index.ts}` and tests; `apps/web/src/i18n/catalog/settings-availability.ts` + register. Modify `ModelsSection.tsx` (mount above the provider list through `LazyBoundary` and `useRetryableLazy`, at most 6 lines), `apps/web/src/i18n/index.ts` and `catalog-keys.test.ts` (one whole line each), `EnabledSwitches.tsx` only if the new rows reuse it (prefer reuse over copy; if reused unchanged, no edit).

**Interfaces:** `use-availability.ts` returns `{ overview, available: AvailableState, mode: "all" | "selection", write(op: EnabledOp): Promise<void>, reload() }`: the overview from the existing `useOverview`, the preview from `models.available` (cwd of the Settings scope as the overview), reloaded after each write, with a sequence guard as `use-overview.ts` has (an older in-flight read never replaces the result of a later write's reload, MP-RT-14); `write` calls `models.setEnabled` (no step-up) and reuses `useModelWrites` for pending keys and failure text. `mode` is `all` when `overview.enabled.patterns === null`, else `selection`. Provider rows: id, name, connected or "not connected" chip (from `provider.auth.configured`), `n/m` count, provider switch, expandable model switches (the existing 100-per-page pattern). A model of an unconnected provider shows the note "Not offered until the provider is connected" and its switch still works (enabling before signing in is allowed, M7R54). Header (owner q3: the mode first, then the switches, then the preview): the segmented control "Tous les modèles des fournisseurs connectés" (calls `clear` only after a confirmation that names how many patterns it removes and keeps the old list visible in the confirmation text, MPR16) / "Ma sélection" (UI mode only until the first switch). Preview: "What your pickers offer": count, origin sentence ("Only the providers you are connected to" / "Your selection, among connected providers"), grouped list (collapsed after 5 groups), updated after each write. Patterns matching nothing (from `overview.enabled.warnings` is text; use the `enabled.patterns` plus the preview to detect, or add the `unmatched` list to the overview if the warnings array cannot be parsed reliably: prefer showing the warning text with a "Clean up" button that calls `{ op: "prune" }`). Extension providers: a button "Read providers added by extensions" calls `models.extensions`, shows providers and models read-only with the note that they appear in a session's model menu only; a `failed` answer says an extension did not load.

**Rulings:** MPR5, MPR16, MPR17, MPR18, MPR22, MPR26.

- [ ] **Step 1 (RED):** vm tests: `mode` from patterns; the count of offered models per provider equals the preview's; a provider with no connected auth is "not connected" and has zero offered. Component tests: switching a model off calls `models.setEnabled` with the toggle op and then reloads the preview (two calls in order, the preview shows the new list); `clear` from the mode switch; project scope (`readOnlyPath`) disables the switches and says why in text (M7R68); the preview never lists a model the fake `models.available` does not return (`preview.is-the-picker-list`); the unconnected-provider note; prune button appears only when a warning matches the "No model matches" form and calls `prune`; extensions button shows read-only rows, no switches, and the failed text; `availability.reload-not-overtaken` (MP-RT-14): a read started before a write resolves after the write's reload and the preview still shows the post-write list; `mode.all-confirms` (MP-RT-17): choosing "all models" shows the confirmation with the pattern count, cancelling calls nothing, confirming calls `clear`; model and provider names go through `stripHidden` (a bidi name renders without it); `unknown_method` and a stale chunk show the reload message; phone layout; all rows 44 px on coarse pointers; the section has no module-level state (render twice with different fakes). There is no "Restrictions" tab or placeholder (owner q11); a French accent test for the catalog.
- [ ] **Step 2:** run: fail. **Step 3:** implement. **Step 4:** `pnpm lint && pnpm typecheck && pnpm exec vitest run --project unit apps/web && pnpm knip && pnpm build && pnpm budgets`.
- [ ] **Step 5 (mutation):** (M1) build the preview from `overview` flags instead of `models.available`: `preview.is-the-picker-list` red; (M2) skip the reload after write: the order test red; (M3) drop the sequence guard: `availability.reload-not-overtaken` red; (M4) call `clear` without the confirmation: `mode.all-confirms` red. Revert. Compare the render with the chosen q3 option of the owner page and board 08 (decision 80; say so in the commit body).
- [ ] **Step 6:** `git commit -m "feat(web): available models view with a live preview and read-only extension providers"`

### Task 15: Chain B close: docs, ADRs 0069 and 0070, C hook, B gate

**Chain:** B tail. **Model:** Sonnet; Sonnet reviewer. **Gate:** the full gate (once, after the rebase on `main` that holds M12, A and M6b).

**Files:** Create `docs/adr/0069-provider-form-writes-models-json.md` (MPR8 to MPR15, MPR28: field-preserving strict-JSON merge, the comments ruling, the URL policy constant and its trade-off (owner q4; the raw editor is the less guarded door), key paths, remove semantics, discover/test stance, and that `$NAME` can name any variable of the helper's environment, as the raw editor already allows), `docs/adr/0070-availability-view-extensions-and-the-policy-hook.md` (MPR16 to MPR18: setEnabled-only writes, preview from the single source, extension providers on click, the C paragraph and the interface line from the spec). Modify `scripts/smoke-models.ts` (add: `models.provider.save` of a loopback provider with `auth: none` through a step-up session, then `models.provider.get` returns it editable, then `models.available` lists its models; the built helper entry carries the new ops), `docs/agents/models.md` (sections "Provider form", "Available models view", "Extension providers", the C hook, "Backups" per MPR29), `docs/research/models-batch-rulings.md` (final MPR list with the owner's answers), `AGENTS.md` (at most one line: the form's browser-only rule and `docs/agents/models.md`; keep at most 150 lines), `docs/agents/web.md` (picker, form, view).

- [ ] **Step 1:** write the docs. Residuals to state in `models.md`: a `models.json` with comments or trailing commas needs the raw editor (the form never rewrites it, MPR11); a LAN `http:` server needs the raw editor under the loopback policy (owner q4; the one-line flip is documented); providers, the selection and keys are not restored by M6b (MPR29); extension models are missing from no-session pickers; no server-side membership check on save; the dummy key literal; the strict-JSON rewrite may change formatting; a trust change reaches the pickers within the 10 s cache TTL.
- [ ] **Step 2 (full gate):** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm budgets && pnpm smoke`. Expected: green; initial bundle about 229 KB gzip (the form and the view are lazy; confirm `pnpm budgets` prints the number and note the real delta in the ledger); every file at most 400 lines.
- [ ] **Step 3 (end to end by hand, preview):** (controller, after the merge; the preview port is the controller's) with the rebuilt preview (`pap-preview`): add a local Ollama-style provider from the form against a stub server the controller starts on a free loopback port; add its key through the key form that follows the save; the key never appears in `~/.pap` logs (grep the marker); the agent form lists its models once the key (or `none`) makes it available; switch one model off in the availability view and see it leave the agent form's picker.
- [ ] **Step 4:** `git commit -m "docs(models): provider form, availability view, ADRs 0069 and 0070, policy hook"`. The controller merges B and rebuilds the preview.

## Controller steps (not implementer tasks; blocking)

There is no browser CI and the host has no browser (headless VPS; m0-m1 ruling R51). The controller proves the scroll in real engines with the official Playwright container, rootless podman, headless, WebKit and Chromium, then removes it.

**Set-up (once per run).** `podman pull mcr.microsoft.com/playwright:v<exact>-noble` (the tag pinned to the exact `playwright` package version the controller installs in a scratch directory outside the repo, as in the M3 notes), start `playwright run-server` in the container with the port published on `127.0.0.1` only (a free port, never 30141, 7777, 8090, 4040, 18022, 18023 or 50026), connect from a Node script in the scratch directory with `exposeNetwork` (fallback `--network host`). The built app is served by the built daemon on a free loopback port under a temporary `PAP_HOME`, `PI_CODING_AGENT_DIR` and `HOME`, with the scripted provider and `PI_OFFLINE=1`; the controller signs in through the setup URL. Nothing touches `~/.pap` or `~/.pi/agent`. At the end: stop the container (`podman rm -f`), kill the daemon, delete the scratch directory.

**C1 (after task 4, BLOCKING for A0).** On the gallery pane (a pane of the signed-in shell, `routes/shell/pane-renderers.tsx`), figure `gallery-select-long` (300 options). For each of Chromium and WebKit and each viewport (390 x 844 touch, 1280 x 800 mouse):
1. open the `Select`; assert the content's bounding box lies inside the viewport (top >= 0, bottom <= viewport height);
2. scroll the list: `mouse.wheel` on desktop, a touch drag (`page.touchscreen`-style swipe through `dispatchEvent` or `locator.evaluate(el => el.scrollTop += 400)` plus a real `wheel` where touch is unavailable) on the phone viewport; assert the viewport element's `scrollTop` increased and the 250th option can be reached and chosen (the trigger's text changes);
3. keyboard: `End` highlights the last option, `Home` the first;
4. on desktop assert the scrollbar is visible: the viewport's `offsetWidth - clientWidth` is greater than 0 (a classic scrollbar takes room) or its computed `scrollbar-width` is `thin` where the engine supports it; attach a screenshot;
5. assert the scroll-down button is present at the bottom edge while the list is not at the end.
Red anywhere: the task goes back to its implementer with the failing engine and viewport. Evidence for the ledger: one screenshot per engine at 390 and 1280.

**C2 (at the join, task 7, BLOCKING for A).** Two scenes, same engines and viewports:
1. figure `gallery-picker-in-dialog` (2000 models inside a modal `Dialog`): open the picker; the popover (sheet on the phone viewport) stays inside the viewport; `mouse.wheel` over the list scrolls the **list** and not the page behind the dialog (the known Radix trap: a popover portaled out of a modal dialog blocks wheel scroll); touch scroll works on the phone viewport; the search input keeps focus, typing filters, Arrow keys and Enter pick; Escape closes the popover first and the dialog second; focus returns to the field;
2. the real New lane dialog on the built app (a signed-in agent dir with one fake plain key, two projects): open it, open a model slot's picker, the same assertions, then change the project and see the slot's list reload.
If the wheel scroll fails, the fix is the `container` prop of the `Popover` (portal into the dialog content) in task 5a's file, then C2 runs again. Evidence: screenshots per engine and viewport.

## Model table

Implementers are Sonnet, never Haiku. Reviewers are Sonnet unless marked Opus. The final review is Opus. **Opus escalation of an implementer at fix rounds 4 and 5 is pre-approved for this wave** (decision 94, as decision 89 c2 did for the previous wave); any other upgrade needs the owner's explicit OK.

| Task | Chain | Implementer | Reviewer | Why the Opus lines |
|---|---|---|---|---|
| 1 `listAvailable`, `freshAvailable` | A-back | Sonnet | Sonnet | |
| 2 `models.available` helper op | A-back | Sonnet | **Opus** | a read that must run no command and no network; a result a token can read |
| 3 Daemon method, cache, wiring | A-back | Sonnet | **Opus** | cache races and invalidation across paths outside the write queue (MP-RT-06); production wiring |
| 4 `Select` fix (A0) | A-front | Sonnet | Sonnet | |
| 5a Popover, vm, hook, scan | A-front | Sonnet | Sonnet | |
| 5b Picker list, field, session menu | A-front | Sonnet | Sonnet | |
| 6 Agent form, new lane | A-front | Sonnet | Sonnet | |
| 7 A join, smoke, docs, gate | A | Sonnet | Sonnet | |
| 8 Form contracts, URL policy | B-daemon | Sonnet | **Opus** | trust boundary, the base URL policy, credential rules, what a receipt keeps |
| 9 Provider helper ops | B-daemon | Sonnet | **Opus** | rewrites a credential-adjacent file; unknown-field preservation; what `get` may return |
| 10 Daemon provider methods | B-daemon | Sonnet | **Opus** | key flow end to end; audit and receipts leak-free; the replay binding |
| 11 Form UI | B-web | Sonnet | Sonnet | no key field, so no secret handling here |
| 12 Form flows | B-web | Sonnet | Sonnet | the key goes through the existing, tested `ApiKeyForm` |
| 13 Extension providers | B-daemon | Sonnet | **Opus** | runs the owner's extension code on a click |
| 14 Availability view | B tail | Sonnet | Sonnet | |
| 15 B close and gate | B tail | Sonnet | Sonnet | |
| Final review of each merge | | | **Opus** | whole-branch security and wiring (A: tasks 1 to 7; B: tasks 8 to 15) |

Opus lines: 2, 3, 8, 9, 10, 13 and the two final reviews (8 Opus reviews). The controller steps C1 and C2 are the controller's own work, not a model.

## Coverage map

| Requirement | Task |
|---|---|
| One source: pickers offer exactly Pi's models for that context | 1, 2, 3, 6 |
| Worker and helper cannot drift (one function, parity tests, warm worker re-read) | 1, 2, 3 |
| Session menu keeps Pi's list and order | 1, 5b |
| Agent form and new lane stop reading the overview flag | 6 (and the scan test, 5a) |
| Any other picker found (subagent profile text, triggers, tasks) | none exist: documented in the spec (section 2); the red-team re-checked |
| One shared, searchable, grouped, scrolling, keyboard- and touch-friendly picker, combobox ARIA | 5a, 5b |
| `Select` bounded and visibly scrollable for every long list, proven in WebKit and Chromium | 4, C1 |
| The picker scrolls inside a modal Dialog | 5a, 5b, 6, C2 |
| Saved model no longer offered stays visible (owner q6) | 5b, 6 |
| Add, edit, remove a provider from Settings (name/id, API type, base URL, key or auth, headers, models by discovery or by hand) | 8, 9, 10, 11, 12 |
| Providers outside the form's grammar and commented files degrade to the raw editor, never an error | 9, 11, 12 |
| Writes through the existing helper ops, no second store; raw editor stays | 9, 10 |
| Base URL policy as one constant and one table, no credentials, SSRF stance, caller kinds | 8, MPR9, MPR15 |
| `models.json` write rules (atomic, mode, unknown fields kept, strict JSON) | 9 |
| API key handling (Pi's auth storage; never in a log, response, audit, receipt, metrics; none in the form) | 8, 10, 12 |
| "Available models" view: mode first, switches, preview; confirm on "all" | 14 |
| Project or global `enabledModels` scope with trust | 2, 14 (as M7R54 to R56, R65) |
| Extension-registered providers, read-only on click (owner q5) | 13, 14 |
| C: hook paragraph and interface line, not built, no UI (owner q11) | spec 8, 15 (ADR 0070) |
| Tests: RED first, real mutation checks, no network, temp agent dir | every task |
| Bundle: eager delta, picker eager/lazy statement | 5a, 5b, 11, 14, 7, 15 |
| MC34 sign-out resets; no new store | 5a, 12 |
| Production wiring traced and the built dist exercised (M11a I2) | 3, 7 (smoke), 10, 13, 15 (smoke) |
| Stale shell / stale chunk after an update | 5b, 11, 12, 14 |

## Exit criteria

| Exit | Proof now | The owner checks by hand |
|---|---|---|
| The bug is gone: a list with your Pi models only, scrolling | tasks 1 to 3, 5a, 5b, 6 tests; controller proofs C1 and C2 in WebKit and Chromium | open the agent form on the preview: only models of providers you are signed in to; scroll a 300-option list on desktop and phone; open the picker from the New lane dialog |
| A change in Settings reaches every picker, also a warm session | task 3 `sessions.models and the helper agree after a write` | switch a model off, open a session's model menu |
| Add a provider from Settings | tasks 9, 10, 12 tests, smoke, task 15 step 3 | add your local server (loopback `http:`; a LAN server goes through the raw editor, owner q4); it appears in the agent form picker |
| Control availability | task 14 tests | switch a model off: it leaves the pickers; the preview shows it |

## Owner answers (2026-10-17)

The owner answered the eleven questions of the page `models-q1` in chat ("Ok pour les modèles de ta reco"): **every answer is the recommendation**. The page and the raw answers are archived as `docs/design/questions/2026-10-17-models.html` and `-answers.json`. Each answer is a ruling.

| Q | Answer | Ruling | Plan change |
|---|---|---|---|
| q1 Picker | popover | MPR6 (owner q1) | Popover anchored to the field, search, grouped, scrolling; sheet on phones; `Popover` is modal (MPR27). Tasks 5a, 5b. |
| q2 Provider form | presets | MPR24 (owner q2) | Preset cards first, then one short form. Task 11. |
| q3 Availability | mode | MPR16 (owner q3) | Mode first, then switches, then preview; confirm on "all". Task 14. |
| q4 Base URL | loopback | MPR9 (owner q4) | `https:` or `http:` to this machine only. **The red-team (MP-RT-04) argued for `http:` to any host with a clear-text warning.** The owner's choice stands; the policy is the one constant `HTTP_PLAINTEXT_POLICY` and the one table `BASE_URL_TABLE` (task 8), so a later flip is one line plus two catalog sentences and no test change (verified in a scratch run). The trade-off is in the ruling and in ADR 0069: the raw editor is a less guarded door to the same result. |
| q5 Extension models | settings | MPR17 (owner q5) | Read-only list in Settings on a click; otherwise only in a session's menu. Tasks 13, 14. |
| q6 Saved model not offered | keep | MPR5 (owner q6) | Stays visible, "Modèle enregistré, plus proposé"; nothing erased silently. No run-start check now (deferred minor D3). Tasks 5b, 6, 14. |
| q7 Key storage | authjson | MPR12 (owner q7) | `auth.json` through `models.setApiKey`, env option, never in `models.json`, dummy literal for a keyless server; no key field in the form (MP-RT-10). Tasks 10, 11, 12. |
| q8 Headers | headers | MPR12 (owner q8) | Custom headers allowed; credential-named headers take an env reference only; a literal never holds `$` or starts with `!`. Task 8. |
| q9 Built-in providers | addonly | MPR13 (owner q9) | The form only adds; a built-in's URL stays in the raw editor. Tasks 8, 9. |
| q10 Merge order | aearly | MPR23 (owner q10) | The fix merges first (A0, then A), the feature rebases once. See "The lane graph". |
| q11 Restrictions | none | MPR18 (owner q11) | Nothing in the UI; the C hook is documented only. Task 15. |

**Two questions the red-team added, ruled in the plan fix (KISS and secure; the owner can overturn either):**
- **A. A `models.json` with comments** (MP-RT-18): Pi accepts `//` comments and trailing commas. The form never rewrites such a file. `get` answers `editable: false, reason: "needs_raw_editor"`, `save` and `remove` answer `config_invalid` `$.file`, the UI points to the raw editor (MPR11; tasks 9, 11, 12). The "rewrite without comments" button the red-team preferred is rejected: a destructive path for an annotated file that the raw editor already handles.
- **B. A saved agent or lane model that is no longer offered** (MP-RT-Q-B, owner q6): it stays visible and pickable; there is no run-start check in this batch; the run fails with Pi's own error; the agent status warning and a server-side membership check are a follow-up (MPR5, deferred minor D3).

## Red-team ledger (`.superpowers/redteam-models.md`, 0 C / 8 I / 15 M)

| Finding | Where fixed |
|---|---|
| MP-RT-01 (I) worker list stale | MPR1, MPR25; task 1 (`freshAvailable`, 4 tests, M5 to M7); task 3 int `after a write` |
| MP-RT-02 (I) get/remove fail outside the grammar | MPR8; tasks 8 (any-id params, `url_unsupported`), 9 (`viewOf`, `get.degrades.*`, `remove.any-id`) |
| MP-RT-03 (I) conflict check defeated, replay unbound | MPR8; tasks 8 (top-level `id`/`mode`, `sensitiveParams`), 10 (`save.replay-other-target`), 12 (`save.revision-from-get`) |
| MP-RT-04 (I) Q4 default | MPR9 and the q4 row above: the owner's choice kept; one constant, one table, trade-off recorded; task 8 |
| MP-RT-05 (I) scroll proof | MPR27, controller steps C1 and C2 (blocking), `modal` Popover, figures in tasks 4 and 5b |
| MP-RT-06 (I) cache races | MPR21; task 3 (generation, single-flight, seven invalidation paths) |
| MP-RT-09 (I) raw `React.lazy` | Global Constraints, MPR6; tasks 5b, 11, 14 (`useRetryableLazy`, `LazyBoundary`, `field.lazy-failure`) |
| MP-RT-10 (I) key field | MPR12; tasks 11 and 12 rewritten (no key field, `ApiKeyForm` after save) |
| MP-RT-07 (M) `!command` divergence | MPR1, MPR2; task 2 parity test, picker footnote (5a catalog, 5b), ADR 0068 |
| MP-RT-08 (M) unknown api loads | MPR10; task 9 (`loadsAs` dropped) |
| MP-RT-11 (M) task 5 too big | split into 5a and 5b |
| MP-RT-12 (M) board citations | Global Constraints; tasks 4, 5a, 5b, 6, 11, 12, 14 |
| MP-RT-13 (M) keyboard and ARIA | MPR6; task 5b |
| MP-RT-14 (M) stale-response guards | tasks 5a (`hook.cwd-change-is-loading`), 14 (`availability.reload-not-overtaken`) |
| MP-RT-15 (M) `i18n/index.ts` in the scans | conflict scan, Global Constraints, tasks 5a, 11, 14; M12's table is the controller's note (D1) |
| MP-RT-16 (M) line budgets | Global Constraints (new names file past 395, second merger recounts), rebase point |
| MP-RT-17 (M) confirm on "all" | MPR16; task 14 (`mode.all-confirms`) |
| MP-RT-18 (M) comments | MPR11 and the answer A above; tasks 9, 11, 12 |
| MP-RT-19 (M) untrusted names | MPR26; tasks 5a, 5b, 14 |
| MP-RT-20 (M) small mismatches | Global Constraints (`blockedAttempts`, `--spacing-s2`), accents in tasks 5a, 11, 14, the scan includes `use-overview` |
| MP-RT-21 (M) built dist not exercised | task 7 and task 15 (`scripts/smoke-models.ts`) |
| MP-RT-22 (M) `$NAME` | MPR12 (`$` refused in a literal), MPR28, ADR 0069; task 8 |
| MP-RT-23 (M) backups | MPR29; task 7 docs; M6b's half is D2 |

## Deferred minors

- **D1** MP-RT-15, M12's half: M12's conflict table does not name `apps/web/src/i18n/index.ts` and `catalog-keys.test.ts`. This plan names them; M12's plan fix should (controller note).
- **D2** MP-RT-23, M6b's half: the M6b restore summary and its Q2 note should say that providers (`models.json`), the selection (`settings.json`) and keys (`auth.json`) are not restored (M6bR3). This plan's docs say it (MPR29).
- **D3** Question B / MPR5: a run-start check, an agent status warning, or a server-side membership check for a saved model that is no longer offered. Follow-up after v1 of this batch; the owner's q6 is met by visibility.
- **D4** A trust change is not wired to the `models.available` cache (the `trust` module is not this batch's); it shows within 10 s. Wire it if the owner notices.
- **D5** MP-RT-22, optional hardening: refuse env names such as `PAP_*` in the form. Not done: it adds no capability over the raw editor (ADR 0069 says so).

## Risks

- **Pi's availability refresh and OAuth** (task 2 probe): the red-team ran it (no network call). If a later Pi changes that, the op uses pap's file facts for OAuth providers.
- **`runtime.refresh` on a live worker** (MPR25): offline and tested against a live session in task 3's int case; a running session is not refreshed. If Pi ever makes `refresh` disturb a running session, the fallback is to refresh only on `set_model`.
- **Strict JSON rule** (task 9): an owner with a commented `models.json` cannot use the form; the message says so and the raw editor works (MPR11).
- **Loopback-only `http:`** (owner q4): a LAN Ollama needs the raw editor; the one-line flip is prepared (MPR9).
- **Extension models** missing from no-session pickers (stated in the footnote and the docs).
- **Popover in a Dialog** (MPR27): `modal` is the planned fix and the controller's C2 decides; the fallback is a `container` prop.
- **Gate contention**: two heavy slots shared with M12 and M6b; only tasks 7 and 15 hold a long slot.
- **No server-side membership check** on agent or lane save (D3).
- **The dummy `local-no-key` literal** in `models.json` for keyless servers is visible in the raw editor (masked there because the key is named `apiKey`); it is not a secret.

## Merge order and conflict notes

- **Order across the three plans (cross-plan agreements, item 10 and the red-team's cut):** A0 (the `Select` fix) first and alone; M12; models A; M6b; models B. A0 touches only `packages/ui` and a gallery figure. Whole-line conflicts are possible only in the shared files named in the conflict scan; the second branch to merge re-counts `AGENTS.md` (150 lines) and the line budgets of `methods.test.ts`.
- **Rebase rules:** `pnpm-lock.yaml` is untouched by this batch (no dependency); `models-methods.ts`, `pi-helper.ts`, `ops.ts`, `methods.test.ts`, `compose-pi.test.ts`, `i18n/index.ts`, `catalog-keys.test.ts` get whole-line additions only; resolve by keeping both sides in alphabetical order.
- **Decisions log:** decision 94 is appended by this plan fix. ADR numbers 0068 to 0070 are this batch's.
- **After each merge:** rebuild and restart the preview (`pap-preview`).
