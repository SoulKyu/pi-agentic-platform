# M3 final review (archived 2026-10-12)

Opus whole-branch review of M3 and its re-review after the fix rounds, copied verbatim from the git-ignored SDD workspace. Ledger: [m3-sdd-ledger.md](m3-sdd-ledger.md).

# M3 final whole-branch review — f765f2a..3c036f3 (58 commits, 336 files)

Reviewer: Opus, read-only on the worktree. Everything that built or ran did so in scratch clones under
`/tmp/claude-1000/m3-final-review/` (`repo` = this branch, `main` = f765f2a, `mergetest` = this branch with
`feat/m2-sessions@7d5892a` merged in).

## Verdict

**Ready to merge once four Important fixes land (I1–I4) and the cheap minors marked "fix before merge" in the triage are done.**
**Before the rebase, the owner has to decide on two things: I5 (custom themes can be lost when two devices edit them) and the bundle at P6 (see the last section).**

What holds up well: the full gate is green and reproducible. Every untrusted-input path fails closed: theme and keybindings imports, the boot cache, URL and workspace ids, model markdown. No chunk has `eval` or WebAssembly except zod's probe (I1). Compare-and-set is correct on the server and the client. Commit hygiene is clean: 58 Conventional Commits, no AI trailers. A trial merge with M2 resolves exactly the three conflicts the plan predicted, and the merged tree stays green.

Counts: **0 Critical, 5 Important, 12 Minor.** Triage of the 49 deferred minors: 6 fix before merge, 11 carry, 32 accept or already closed.

## Gate results

Scratch clone of 3c036f3, `pnpm install --frozen-lockfile --prefer-offline`, worktree pnpm shim (10.34.6), node 24.14.1.

| Step | Result |
|---|---|
| `pnpm lint` | exit 0 (`--max-warnings=0`) |
| `pnpm format:check` | exit 0, "All matched files use Prettier code style!" |
| `pnpm typecheck` | exit 0 (5 workspace projects + root) |
| `pnpm knip` | exit 0, no findings |
| `pnpm test:unit` | exit 0, 208 files, **2067 / 2067** passed (27 s); re-run 3 more times: 2067 / 2067 each time, no flake seen (4 / 4) |
| `pnpm test:int` (`env -i PATH HOME LANG=C.UTF-8 CI=1`) | exit 0, 25 files, **207 / 207** passed (39 s), no stray stderr |
| `pnpm build` | exit 0; entry `index-*.js` 406.57 kB / 134.45 kB gzip (vite) |
| `pnpm smoke` | exit 0: healthz + page, owner created, session subscribed, prompt → approval → tool output → agent_settled, SIGTERM exit 0, 1 worker gone |
| `pnpm budgets` | exit 0: **initial 192.1 KB gzip (budget 200)**, 15 initial files; lazy chunks listed (Settings 34.7, highlighter 47.3, renderer 46.3, overlays 14.4, palette 5.9, theme editor 3.7…) |

The same gate on the trial merge with M2 (`mergetest`): lint, typecheck, knip, unit (254 files, 2678 tests), int, build, smoke and budgets all exit 0, with an initial bundle of **195.2 KB**. `format:check` flagged only a line I hand-wrote while resolving `daemon.ts` (an artefact of the trial, not an M3 issue). The one stray stderr line in the merged unit run (`pi-host: custom_input_too_long`) comes from M2.

### Exit criteria (header, as amended by C1 and R3-x)

| Criterion | Status |
|---|---|
| lint clean incl. `no-raw-colors` (only presets/contrast/derive exempt), `no-arbitrary-values`, `no-restyle`, `no-native-title`, `zustand-selector`, boundaries, 400-line cap | ✅ (largest code file: `i18n/catalog/settings-screen.ts` 382 lines; `tokens.css` 340, `utilities.css` 155) |
| class coverage, literal gate, compiler gate + pipeline (all but `features/sessions`) | ✅ |
| tokens, token classes, i18n, Safari 16.4 floor, no CSS nesting, notices | ✅ |
| build-output: no inline script, boot script first, fonts as files, no wasm, no gallery in prod; palette / Settings / theme editor / markdown lazy-only | ✅ |
| build-output: **shortcuts help** out of the initial assets | ⚠️ true in the build, **not pinned** (I4) |
| account settings CAS + field-wise parsing tests | ✅ |
| 44-px targets as classes; keyboard / shell / phone in happy-dom | ✅. The probe checks height only (`Gallery.test.tsx:26`), see m2 |
| typecheck, knip, format, unit, int, build, smoke; `ci-config.test.ts` unchanged | ✅ (`scripts/ci-config.test.ts`, `.github/`, `pnpm-workspace.yaml` unchanged in the range) |
| `budgets.json` re-set from the M3 build, ≤ 200; `pnpm budgets` exit 0 | ✅ 200 = min(ceil(192.1 × 1.10) = 212, 200) |
| Owner R3-1 (lazy markdown, shiki JS engine, CSP unchanged) | ✅. No `.wasm`; the only `Function(` in any chunk is zod's probe (I1) |
| R3-2 reset keeps themes · R3-3 language per device · R3-4 CAS + merge + 1 retry · R3-5 ≤ 200 · R3-6 Escape keys · R3-7 physical keys · R3-8 settings module · R3-9 throttle copy | ✅ (`session.stop` stays unclaimed until P3, by design) |
| CSP R74 header unchanged | ✅ `apps/daemon/src/kernel/` unchanged in the range; but see I1 for a runtime violation |

## Critical

None.

## Important

### I1. One CSP violation on every page load: zod builds schemas before `jitless` is set. M3 introduced it; it is not pre-existing on main.

- **Where.**
  - `apps/web/src/main.tsx:1` imports `./csp-safe-zod.ts`, and `apps/web/src/csp-safe-zod.ts:7` calls `z.config({ jitless: true })`.
  - In the build, though, the entry's static import `settings-*.js` is evaluated before the entry's own body runs. That shared chunk holds zod and the `@pap/contracts` settings schemas.
- **What happens.** zod 4.6.5's `$ZodObject` init reads `allowsEval.value` at construction (`zod/v4/core/schemas.js:1166-1168`), so the first `z.object` built in that chunk runs `new Function("")`.
- **Proof.**
  - Importing the built `settings-Cx11V2JZ.js` in Node with `Function` blocked records **1 attempt (`[""]`)** during evaluation.
  - Importing zod alone records 0.
  - On main (f765f2a, built in scratch) the web build is a single chunk, and `jitless:!0` sits at byte offset 88 167, before the contracts schemas (offset 395 375). So code splitting on this branch introduced the bug.
- **Why the test missed it.** `csp-safe-zod.test.ts:45-48` only pins the source order.
- **Impact.**
  - One `securitypolicyviolation` plus a console error per load. zod then caches `allowsEval=false` and keeps working without JIT.
  - The **daemon does not log CSP reports**: the policy has no `report-uri` / `report-to` (`apps/daemon/src/kernel/http/app.ts:25-36`), and no route accepts reports. The noise stays in the browser console and the DevTools Issues panel. It would become one report per load the day a reporting directive is added.
  - It would also fail the deferred "zero CSP violations" browser check.
- **Fix (prototyped in scratch).**
  - A web-only alias, with no contracts change and therefore no M2 conflict:
    ```ts
    // apps/web/vite.config.ts
    resolve: { alias: [{ find: /^zod$/, replacement: fileURLToPath(new URL("./src/csp-safe-zod.ts", import.meta.url)) }] },
    // apps/web/src/csp-safe-zod.ts
    import * as z from "zod/v4";
    z.config({ jitless: true });
    export * from "zod/v4";
    export { z, z as default };
    ```
  - Result: 0 attempts in the rebuilt zod chunk; the initial bundle stays at 192.1 KB; `csp-safe-zod.test.ts`, web `tsc`, eslint, knip and prettier all pass. Keep `main.tsx:1` as it is.
  - **Build-level test** for `build-output.int.test.ts`:
    1. Find the asset that holds zod's probe (marker `/Cloudflare/`, from `allowsEval`).
    2. Run `node <probe.mjs> <asset>` (`execFile`). The probe replaces `globalThis.Function` with a proxy that throws on any argument, imports the file and prints the attempt count.
    3. Expect `0`. This is RED today (1) and GREEN with the alias.

### I2. Closing the last tab at `/` leaves a blank pane, and New tab, ⌃⌥N and the logo then do nothing (reproduced)

- **Where.**
  - `routes/shell/use-shell-effects.ts:25-29` opens the URL's item only when `pathname` changes.
  - `routes/shell/tab-actions.ts:16-19,31-38` navigates to `/` after the last close.
- **What happens.** When the only tab is home and the URL is already `/`, the pathname does not change, so nothing reopens it. `PaneHost` gets `tab=null` and renders nothing. `go(navigate, "/")` from New tab, `session.new` and the rail logo link are all no-ops for the same reason.
- **Proof.** A scratch test with the real shell bed showed 0 tabs after the close, still 0 after clicking "New tab", and the path still `/`.
- **Impact.** The user is stuck on an empty workspace until they open Settings or reload. Closing the last tab anywhere else lands on `/` and reopens home, so only this case dead-ends.
- **Fix.** Restore the invariant "the URL names the active item": add `const empty = useWorkspaceStore((s) => s.ws.active === null)` to the effect's dependencies, so an empty workspace re-opens the URL's item. Add the scenario as a test in `TabBar.test.tsx`: close the lone home tab at `/`, then expect one home tab.

### I3. The overlay menus in the Rail and the split header bypass `LazyBoundary` (M3R99); a stale chunk replaces the whole shell (reproduced)

- **Where.** `routes/shell/Rail.tsx:11` and `routes/shell/PaneHost.tsx:11` duplicate a module-level `lazy(() => import("@pap/ui/overlays"))`, wrapped only in `<Suspense>` (`Rail.tsx:49`, `PaneHost.tsx:76`).
- **What happens.**
  - After a pap update renames `overlays-*.js`, clicking **Account** (the path to sign out) or **Show in this pane** throws into TanStack's root error component.
  - The rail, tabs and panes disappear behind "This screen stopped working". It is reported as `render_failed`, not `lazy_chunk_failed`.
  - React caches the rejected `lazy` for good, so a retry never happens.
- **Proof.** A scratch test with `@pap/ui/overlays` failing: the rail is present before the click and absent after it.
- **Contrast.** The drawers, palette and help (`LazyPanel`) keep the shell standing and offer Reload.
- **Duplication.** `features/appearance/CustomThemes.tsx:195-213` re-implements `LazyPanel` inline. That is a third copy of the pattern.
- **Fix.**
  1. Give `LazyBoundary` an optional `fallback` (rendered while loading and after a failure).
  2. Add one `LazyMenu` in `lib/` (`useRetryableLazy` + `LazyBoundary`, fallback = the plain trigger, `notifyLazyFailure` once) and use it in both places.
  3. Move `LazyPanel` to `lib/`, passing its two strings as props (`web-lib` must not import `web-i18n`, which already imports `lib/report.ts`), and use it in `CustomThemes`.
  4. Pin it with a test: overlays chunk failing → rail still present → toast with Reload.

### I4. The exit criterion "shortcuts help out of the initial assets" has no check, and neither do the overlays

- **Where.** `build-output.int.test.ts:131-162` pins Settings, primitives, the appearance panel, the shortcuts editor, the theme editor, markdown and cmdk. Nothing pins `ShortcutsHelp`, nor the Radix Dialog / Menu stack that Task 19b's ruling moved to `@pap/ui/overlays`.
- **Risk.** A static import would bring back about 14 KB. Today only the budget catches that, indirectly (192 + 14 > 200), and it stops catching it as soon as P6 changes the budget.
- **Fix.** `it("keeps the overlays and the shortcuts help out of the initial assets", () => keepsLazyOnly([/"data-pap-modal":/, /"data-command":/]))`. Both markers are verified lazy-only in the current build: `overlays-*.js`, and `SettingsScreen-*` / `ShortcutsHelp-*`. Then update `docs/agents/web.md:47`.

### I5 (plan-mandated, carry, owner decision). The custom theme library can lose a theme when two devices edit it

- **Where.** `features/appearance/model.ts:100-108`. `mergeAccount` merges by field, and `customThemes` is one field.
- **Scenario.**
  1. Device B loaded before device A added theme T1.
  2. B then adds, edits or deletes any custom theme.
  3. B's save conflicts, B re-reads, and the merge keeps B's whole list. T1 is gone, silently.
  4. There is no live sync (M3R63), so B's view goes stale for as long as its socket stays open.
- **Why it matters.** This contradicts Review Focus 6 ("no change is lost or overwritten by a stale copy"), which M3R48 and M3R60 rate high. The keybindings list (`keybindings-store.ts:86`) has the same shape, but it is edited less often.
- **Fix.** A three-way merge by theme id:
  - `createAccountDocument` keeps the last adopted server value as the base.
  - The merge applies local adds, edits and deletes (by id, relative to that base) onto the server list.
  - Test: two documents, a stale device adds T2 while the other added T1 → both remain after the conflict retry.
  - If this is not done before merge, write the limitation into `docs/agents/web.md` now and file it as a follow-up before the owner relies on two devices.

## Minor

- **m1 — the toast region is announced in English.**
  - `packages/ui/src/primitives/Toast.tsx:90`: the `Radix.Viewport` has no `label`, so screen readers hear Radix's English "Notifications (F8)" in a French UI. This is the deferred Task 8 minor, and it breaks DESIGN §11 ("every string through i18n").
  - Fix: a `regionLabel` prop on `Toaster` (`main.tsx` passes `t("ui.notifications")`).
- **m2 — touch targets are too narrow under `pointer: coarse`.**
  - Segmented items (`Segmented.tsx:5`) and the toast action (`Toast.tsx:77`) carry `min-h-11` but no `min-w-11`. Settings › Language "EN / FR" are about 30 px wide on phones, below DESIGN §5's 44 × 44.
  - The probe (`gallery/Gallery.test.tsx:26`) accepts height-only classes.
  - Fix: add `pointer-coarse:min-w-11` to both, and have the probe require `size-11`, or `min-w-11` together with `min-h-11`/`h-11`.
- **m3 — the Switch label cannot be clicked** (`Switch.tsx:18`). The label is a `<span>`, so clicking the text does not toggle (deferred Task 6 minor). Fix: `<label htmlFor={id}>` with `id` on `Radix.Root`.
- **m4 — M1 alias classes remain in M3-owned files.**
  - `text-attention` is used in `routes/RootLayout.tsx:27`, `features/auth/LoginScreen.tsx:64` and `features/auth/SetupScreen.tsx:67`.
  - P1 greps only `features/sessions`, so it misses them; class coverage would fail when P1 deletes the alias block.
  - Fix now: `text-err` for these error lines, or `text-attn`.
- **m5 — the agent docs are inaccurate in places.**
  - `docs/agents/web.md:9`: not every lazy screen goes through `LazyBoundary` (I3, and the DEV gallery).
  - `web.md:25`: the command specs live in `defaults.ts`, not `registry.ts`.
  - `web.md:27`: the dispatcher does **not** bail out on reserved chords. Only the recorder and the import check `isReserved`.
  - `web.md:44`: "features/sessions is scanned from P7" reads as if it were done. Write "excluded until P7".
  - `web.md:54`: the zod chunk is `settings-*` (25.2 KB gzip), not `runtime-*` (29 KB).
  - `docs/agents/daemon.md` does not mention the `settings` module (Task 12 deferral). Add CAS, the 128 KiB cap, the damaged-row rule and the migration stamp.
- **m6 — Undo after Reset can leave a save error that sticks.**
  - `features/appearance/AppearancePanel.tsx:37-40` restores `previous.account.darkTheme/lightTheme` even when that custom theme was deleted after the reset.
  - The server's `superRefine` refuses the document, the status stays "error", and every later save re-sends the same invalid document.
  - Fix: `setAccount(parseAccount({ ...previous.account, customThemes: current }))`, so the side falls back.
- **m7 — every lazy failure is called a stale chunk.**
  - `lib/lazy.tsx:31-33`, `routes/shell/LazyPanel.tsx:24-28` and `CustomThemes.tsx:197-202` report every caught error as `lazy_chunk_failed` and show the "pap was updated" copy, even for a render bug in the panel.
  - Fix: reuse `isStaleChunk` (`PaneBoundary.tsx:10`) to report `render_failed` with a generic message.
- **m8 — dead or inconsistent code.**
  - `features/commands/registry.ts:6-7,34-37`: `onRegistryChange`, `listeners` and `changed()` are used only by a test (the palette never subscribes). Delete them, or use them in `PaletteHost`.
  - `i18n/en.ts:34` and `fr.ts:34`: the `account.logout` key has been dead since `AccountBar` was deleted.
  - `CommandPalette.tsx:14`: the `platform` prop is unused (it is passed at `PaletteHost.tsx:70`).
  - `TreeDrawer.tsx:17` lacks the defensive `.catch` that the other three `refresh()` calls carry (`use-shell-effects.ts:41,58`, `PaletteHost.tsx:39`).
  - There are two navigation helpers, `go` (`tab-actions.ts:13`) and `navigateTo` (`navigate.ts:5`). Keep one.
- **m9 — account caches outlive sign-out.**
  - The account caches are per browser, not per user (`appearance-store.ts:45-52`, `keybindings-store.ts:24-32`).
  - When the server has no document, `load` adopts nothing (`lib/account-setting.ts:106-110`). After a sign-out and a sign-in as another account, the first change saves the previous user's cached document, custom theme names included.
  - pap has a single owner today, so this is a carry: clear `pap.appearance.account.v1` and `pap.keybindings.v1` on sign-out (as R2-4 does for drafts) when multi-user arrives.
- **m10 — the lazy Settings catalog is nearly full.** `i18n/catalog/settings-screen.ts` has 382 of 400 lines. The next Settings section (devices, M5) must split it, for example into `settings-appearance.ts` and `settings-shortcuts.ts`.
- **m11 — a duplicate i18n key would win silently.** `i18n/en.ts:8-11` spreads the M3 catalogs before the literal keys, so a duplicate key in M2's block wins without any error. No collision exists after the trial merge. Fix: add a disjointness test at P7 (catalog keys ∩ literal keys = ∅).
- **m12 — the build test reads only one CSS file.** `build-output.int.test.ts:30-31` reads only the first `.css` asset. That is correct today (one file), but a second CSS chunk would go unchecked for nesting, `data:` and `@import`. Fix: iterate over all CSS assets.

Global listeners and timers: none leak. The dispatcher, `matchMedia`, the viewport hook, the appearance controller (HMR dispose) and the account documents all clean up. The remaining timers are one-shot: the 40 s Blob revoke, and Reasoning's linger, which is cleared.

## Deferred-minors triage (49 ledger lines)

**F** = fix before merge (cheap or user-facing) · **C** = carry (destination named) · **A** = accept or already closed.

| Ledger | Task | Item | Triage |
|---|---|---|---|
| 13 | 1a | ADR 0012 quotes ratios the test does not pin | A: thresholds are pinned; the ratios are documentation |
| 14 | 1a | alias test missed human-/attention- tint/line | A: closed (`scripts/token-classes.test.ts:50`) |
| 15 | 1a | `--shadow-overlay` / font stacks not compared with DESIGN; fallback specificity; comments cite Orca paths | A |
| 20 | 1b | `@theme`/`@utility` test asserts absence only; alias list duplicated | C → P1 (alias list goes away; add the positive asserts then) |
| 21 | 1b | nesting regex misses `}&`; Button test title; stale `/src/fonts` path in `vite-config.test.ts:45-46` | A (cosmetic) |
| 26 | 2 | `M2_OWNED_UNTIL_P7` duplicated in `compiler-gate.test.ts:11`; no failing fixture; no-native-title misses member/spread | C → P7 (delete all three exclusion copies; add a compiler-gate failing fixture) |
| 36 | 3 | literal-gate blind spots; report clock-backwards; serverText surrogates/bidi; stale allowlist; boundaries | C → P7 (gate blind spots, once M2's files are scanned) and P4 (serverText); rest A |
| 44 | 4 | ProgressBar Infinity; Spinner/Icon untested; inline clock re-arms timers | A (re-arm is deadline-based, harmless) |
| 50 | 5 | IconButton throws outside TooltipProvider | A: closed by Task 19b (provider is a pass-through; Tooltip loads its own) |
| 51 | 5 | pass-through attrs untested; danger regex; delays; disabled IconButton has no tooltip | A |
| 55 | 6 | Segmented lacks coarse min-w; Switch label not clickable; hairline container border | **F** (m2, m3); border A (plan-mandated) |
| 56 | 6 | weak tests; Select popup width | A |
| 63 | 7 | Avatar role=img hides badge/presence; OpenTab truncated title unreadable; export order | C → M11 (avatars with agents) and M4 (tabs); rest A |
| 66 | 7 | OpenTab h-bar vs 44 px on coarse; Meter guard; Badge Infinity/0.5 | C → deferred browser e2e (needs a device); rest A |
| 70 | 8 | toast region label English; Safari focus return; toasts under a modal; Escape top-overlay test | **F** region label (m1); C → browser e2e (Safari/iOS) for the rest |
| 75 | 9 | branch position not announced; Fence hostile test; RunStatus; MessageActions; repeated author | C → P3 (adoption + live regions) |
| 79 | 10 | ApprovalCard header textContent; ToolCard name not clipped; context not described | C → P3, **must**: `min-w-0 truncate` on the tool name before ToolCard shows extension names |
| 87 | 10b | synchronous highlighting on every streaming delta; plain fallback lacks `text-chat`; boundary never resets | C → P3, **must**: highlight settled fences only, or debounce; rest A |
| 94 | 11 | Mark/Wordmark doc comments; weak favicon check | A |
| 99 | 12 | crossing tests (16 themes, string caps, byte boundary); `as never`; daemon.md note | **F** daemon.md note (m5); tests A |
| 106 | 13 | 64-entry cap uncrossed; preset literals duplicated; `in` vs `hasOwn`; parseDevice arrays | A (inputs are own field names; arrays fall back to defaults) |
| 111 | 14 | varValue bounds; no raw length cap; iOS theme-color flash; module-global `pending` | A (self-inflicted only) |
| 117 | 15 | Timers duplicated vs runtime; mutation checks not run | A |
| 122 | 15 | stale comment `controller.test.ts:36`; `held` in pump `.catch` untested | A |
| 128 | 16a | non-ASCII treated as shifted; ß → SS label | A |
| 132 | 16a | `aria-keyshortcuts` `Control++`; Equal-key letter layouts | A |
| 137 | 16b | Alt+↑/↓ and Ctrl+Alt+1..9 fire in text fields | C → M11 (handlers arrive with agents; today unclaimed, keys pass through) |
| 145 | 17a | handler type; throw test; listener isolation; no command id in log | A (delete `onRegistryChange`, m8) |
| 150 | 17b | startup resolution issues unreported; non-array silent; help shows last chord only | A |
| 155 | 18 | no-op returns new object; two tabs share `pap.workspace.v1` | A (document last-writer-wins in web.md) |
| 164 | 19a | PaneHost previous tab for one commit; NotFound `.catch` | A: `.catch` closed (`NotFound.tsx:17`) |
| 178 | 19b | 33rd missing id; resting pointer; tooltip chunk failure unreported | A |
| 184 | 20 | disabled split tooltip; active tab not scrolled into view; redundant aria-label; pointercancel commits | C → M4 (tab overflow); rest A |
| 188 | 20 | weak close tests; module-level `focusAfterClose` | A |
| 196 | 21 | blank drawer until the chunk loads; cached failed fetch | A |
| 199 | 21 | AppShell shortcuts test hard-codes product chords | A (still open at `AppShell.test.tsx:231-255`; low value) |
| 206 | 22 | unused `platform` prop; initial result count not announced; no phone-sheet test; nested scroll | **F** drop the dead prop (m8); rest A |
| 209 | 22 | tie-break not provable | A |
| 219 | 23 | phone↔desktop state loss; 100dvh; toast over-lift under zoom | C → deferred browser e2e (needs a device) |
| 222 | 23 | `data-shell` set in `useEffect`; empty-sheet test en only | A (affects only the toast offset of the first paint) |
| 233 | 24 | test bed header repeated | A |
| 236 | 24 | LazyPane failure has no `role=alert` | A (the toast announces it) |
| 252 | 25 | exempt list existsSync; Markdown gate `finally`; slider at 12.5 | A: existsSync closed in Task 26 |
| 260 | 26 | TextField shared chunk; index keys on capped errors | A |
| 263 | 26 | hex fixtures in JSON to dodge `no-raw-colors` | A |
| 273 | 27 | row handlers use render-time `user`; import `.catch` untested | A |
| 276 | 27 | AltGr inferred from ctrl+alt; Linux warning wording | A (copy says "may") |
| 286 | 28 | probe failure message lists no item names | A; extend the probe to width with m2 (**F**) |
| 294 | 32 | web.md "scanned from P7"; lazyAssets fixture | **F** web.md wording (m5); fixture A |

## Merge-readiness notes (M2 first, then M3 rebases)

### Trial merge

`feat/m3-design` merged with `feat/m2-sessions@7d5892a` (M2 at Task 15 of 30; web Tasks 24–29 not started).

- **Conflicts.** Exactly three files, all union-resolvable as the plan's table says:
  - `apps/daemon/src/daemon.ts`: the `sources` and `handlers` lines. M2 orders `POLICY_MIGRATIONS` before `SESSIONS_MIGRATIONS`; keep its order and append `SETTINGS_MIGRATIONS`.
  - `packages/contracts/src/methods.ts`: imports.
  - `packages/contracts/src/permissions.ts`: `DOMAINS`.
- **Auto-merged:** `en.ts`, `fr.ts`, `SessionScreen.test.tsx`, `knip.json` and `pnpm-lock.yaml` (`--frozen-lockfile` accepted it). After the union, the full gate is green (see Gate results).

### Shared files the conflict tables do not list

- `packages/contracts/package.json` gained `"sideEffects": false` (Task 32). At the rebase, check that none of M2's contracts files performs a top-level side effect (a config call or a registry), or the web build will drop it silently.
- `scripts/check-budgets.ts`: M2's Task 23 adds two budget lines; M3 added `lazyAssets`. Union them.
- `docs/agents/daemon.md`, if m5 lands before the rebase. Union.

### Migrations

M3 adds exactly one: `apps/daemon/src/modules/settings/migrations/202610111000_settings.sql`.

- It already sorts after M2's current `202610110100_policy.sql`. **Re-stamp only if M2's final newest stamp sorts after `202610111000`.**
- Renaming is not free for a home that already applied M3's migration. `kernel/db/migrate.ts:99-106` treats an applied id that is missing from the sources as `database_newer_than_binary` and goes read-only.
- So any `PAP_HOME` that ran an M3 build (owner LAN tests on `~/.pap`) needs a reset, or the rename must be avoided.

### Must-keep `@pap/ui` API (agreement 5)

`Button`, `TextField`, `Message`, `ApprovalCard` with its M1 props, `cn`, `FOCUS_RING` and `once` are all exported (`packages/ui/src/index.ts:1-8, 12, 28-29, 65-66, 88`). M2's `SessionScreen` and `SessionListScreen` typecheck and pass their tests against them on the merged tree.

### ApprovalCard convergence

The answer sets are identical: ui `"deny" | "once" | "session" | "always"` (`ApprovalCard.tsx:9`) and M2's `ApprovalAnswer = z.enum(["once","session","always","deny"])` (`contracts/src/policy.ts:7`).

**Both packages export the name `ApprovalAnswer`.** M2's is a value plus a type, so P3's type test and any file that imports both must alias one of them.

### `data-terminal-input` / `panelFocus`

- The dispatcher listens in the capture phase on `window` (`features/commands/dispatcher.ts:41`). M2's `stopPropagation()` inside the panel (bubble phase) therefore does not shield keys from it; only the `panelFocus` key does (`context.ts:28`).
- P3 must put `data-terminal-input` on M2's `CustomPanel` (M2 Task 27), and test that Escape inside it does not stop the run.

### i18n blocks

- M2's delimited block sits after M3's spreads: no duplicates, and the `IDENTICAL_IN_FR` test is green on the merged tree.
- `i18n.test.ts` → `.tsx` rename: M2 has not touched the file, so there is no modify/delete conflict.
- m11 is the residual risk.

### `budgets.json` and `DESIGN.md`

- `budgets.json`: 200 survived the auto-merge (M2 is still at 180).
- `DESIGN.md`: M3 touched only the §3 tables and §7.4. M2's §9 ANSI rule is not on M2's branch yet; the sections differ.

### P7 removes three exclusion copies, not two

`scripts/class-coverage.ts:20`, `scripts/literal-coverage.ts:26` and **`apps/web/src/compiler-gate.test.ts:11`**. The plan's P7 row names only the first two.

Preview, with all three removed on the merged tree:
- class and literal gates are clean over M2's current files;
- the compiler gate finds 1 bailout (`SessionListScreen.tsx` try/finally, already known).
- M2's web Tasks 24–29 will bring the bulk of P7's work.

### P1, P3 and P2

- **P1:** widen the grep to `apps/web/src`, or fix m4 now.
- **P3:**
  - Two sources of the session list will coexist: M3's `sessions-cache.ts:26` and M2's `SessionListScreen.tsx:27`, both calling `sessions.list`. Unify them.
  - Ledger 79 (ToolCard name clip) and ledger 87 (highlighting on streaming deltas) are **must** items.
  - M2's test helper no longer needs a `TooltipProvider`: it is a pass-through now.
- **P2:** the dialogs M2 builds on main cannot use `@pap/ui/overlays`. Promote them behind `@pap/ui/overlays` and a lazy boundary, never into the eager barrel.

### Sequencing hazard

The post-rebase gate runs `build-output`'s budget check at 200 **before** P6. If the merged initial bundle is above 200, the gate is red and P1–P7 cannot start green. See below.

## Bundle risk at P6

### Measured

| Build | Initial gzip |
|---|---|
| M3 alone | **192.1 KB** (15 files). Largest initial files: entry 132.4, zod + settings schemas `settings-*` 25.2, CSS 7.7, IconButton/Tooltip chunk 7.1, router `dist-*` 7.1, i18n 6.1 |
| M3 + M2@7d5892a (M2 Tasks 1a–15, no web UI yet) | **195.2 KB** (+3.1: protocol v2 schemas, reducer, i18n) |
| Same + what P3 makes eager (`ToolCard`, `Reasoning`, `AuthorGroup`, `MessageActions`/`MessageBranch`, `Markdown` wrapper, `RunStatusChip`, `DaySeparator`, imported in `main.tsx` in scratch) | **199.2 KB** (+4.0) |

### Still to come

M2's web Tasks 24–29 are all eager in `features/sessions`: composer with drafts and queue strip, transcript rows and history, four-answer approval, select / input / editor / confirm dialogs, status bar, widgets, custom panels with ANSI, session-action menus, branch switcher, always rules, minimap.

- **M2's own trigger (M2R147) is 180 measured on M2's branch**, whose base is M1's 138 KB. M2 may therefore legitimately add about 40 KB eager before it splits anything.
- If M2 adds `radix-ui` dialogs or menus eagerly, the roughly 14 KB stack M3 moved to `@pap/ui/overlays` comes back.
- **Estimate without levers: about 205–225 KB at P6. Probability of exceeding 200: very high (> 85 %).**

### Levers (measured where possible)

1. **Lazy session screen.** `routes/shell/pane-renderers.tsx:4,28` → `LazyPane` for `SessionScreen`, the same pattern as Settings.
   - Measured on the merged tree: **195.2 → 190.5 KB** (session chunk 6.4 KB gzip). The saving grows with every M2 web task and takes P3's AI components along.
   - `SessionListScreen` stays eager, so the first paint at `/` is unchanged. Cost: one chunk fetch on the first open of a session (LAN, then cached); `LazyPane` already handles a stale chunk.
   - **Apply it at the rebase, before the post-rebase gate,** or on M3 now; the file is M3-owned.
2. **Amend agreement 10 / M2R147 now, before M2's Tasks 24–29.**
   - M2's real share of the ceiling is about 200 − 192.1 − 4 (P3) ≈ **4 KB eager**, not 42.
   - Its dialogs, `CustomPanel`, `Minimap`, branch switcher and action menus go behind `lazy()` inside `features/sessions`.
   - No eager Radix overlays.
3. Lazy `MobileShell`: −1.7 KB, at the cost of a blank frame on phones (left out of M3 by ruling; still available).
4. If the merged build is still above 200: the owner decides (R3-5, agreement 10), **before** the post-rebase gate, not at P6.

### Recommendation

Do lever 2 now (a controller and plan note for M2) and lever 1 at the rebase. With both, P6 should land around 190–198 KB, depending on how much of M2's UI stays on the home screen.


---

# Re-review after the fix rounds

# M3 final re-review — fix batch 3c036f3..e61b01b (15 commits)

Reviewer: Opus, read-only on the worktree. Everything that built, ran or was mutated did so in scratch:

- `/tmp/claude-1000/m3-final-review/repo`: e61b01b. Used for the gate, the mutations and the scratch tests; restored clean afterwards.
- `/tmp/claude-1000/m3-rereview/merge`: e61b01b with `feat/m2-sessions@eab6088` merged in (M2 Tasks 1a–17a).
- `/tmp/claude-1000/m3-rereview/tests/`: the scratch tests (`rr-*.test.ts[x]`).
- `/tmp/claude-1000/m3-rereview/logs/`: the logs.

## Verdict

**Not merge-ready yet: one new Important item (N1), introduced by lever 1 (134abd4).**

- **N1.** Every switch to a session tab now shows a blank pane for about 300 ms, even when the chunk is cached. Settings tabs already behaved this way.
- **The fix is small.** It is about 15 lines plus one test. I prototyped and measured it: 315 ms → 21 ms, the same as eager.
- **Once N1 lands, the branch is merge-ready.**
  - I1–I5, m1–m8 and m12 are all **ADDRESSED**.
  - The gate is green on the branch and on the trial merge with M2.
  - N2–N4 are Minor and cheap. Do N2 before the rebase.

Counts: **0 Critical, 1 Important (N1), 3 Minor (N2–N4), 5 nits.** Carried by ruling and unchanged: m9, m10, m11 and the triage C rows.

## Gate

| Step | e61b01b (scratch, `--frozen-lockfile`) | e61b01b + M2@eab6088 |
|---|---|---|
| lint · format:check · typecheck · knip | exit 0 · exit 0 · exit 0 · exit 0 | exit 0 · exit 0 (after prettier on my two hand-resolved lines) · exit 0 · exit 0 |
| test:unit | 211 files, **2086 / 2086**, run 3 times, 3 / 3 green | 268 files, **2813 / 2813** |
| test:int (`env -i PATH HOME LANG=C.UTF-8 CI=1`) | 25 files, **210 / 210**, no stderr | 39 files, **261 / 261** |
| build · smoke | exit 0 · ok (prompt → approval → tool output → agent_settled, SIGTERM 0, 1 worker gone) | exit 0 · ok |
| budgets | **189.7 KB / 200**, 17 initial files, SessionScreen chunk 5.0 KB | **191.6 KB / 200**, SessionScreen chunk 6.7 KB |

The trial merge had the same three conflicts as before (`daemon.ts`, `methods.ts`, `permissions.ts`). All three were union-resolvable, and nothing new appeared.

**File size.** No file in the range is over 400 lines. The largest changed file is `apps/web/src/lib/account-setting.test.ts` at 388 lines, so it is near the cap. No tracked code file is over 400.

## Status per item

| Item | Status | Evidence (my own runs) |
|---|---|---|
| I1 zod before jitless | **ADDRESSED** | See "Repros re-run". 0 eval attempts in the build. Mutations A and B are caught. The probe can still give a false green (N2) |
| I2 blank pane at `/` | **ADDRESSED** | Scratch repro green: close the lone home tab at `/` → `[home]`, then New tab and `tab.close` still work. The same holds at `/s/a` and at `/settings/appearance`: you land on `[home]` only, and the item you closed does not reopen |
| I3 menus bypass LazyBoundary | **ADDRESSED** | `overlay-failure.test.tsx` green. Scratch variant: two presses with the chunk gone → two Reload toasts, the rail stays and "stopped working" never appears |
| I4 overlays / help not pinned | **ADDRESSED** | `"data-pap-modal":` appears only in `overlays-*.js`, `"data-command":` only in `SettingsScreen-*` and `ShortcutsHelp-*`. `keepsLazyOnly` fails closed (`holders > 0`) |
| I5 themes lost across devices | **ADDRESSED**, with residuals | See "I5 merge semantics". N3 is a residual loss path |
| m1 toast region in English | **ADDRESSED** | `Toaster` requires `regionLabel`, and `main.tsx` passes `t("ui.notifications")`. A test pins the region's `aria-label` |
| m2 coarse width | **ADDRESSED** for Segmented, the toast action and OpenTab | The Checkbox change satisfies the probe without enlarging the hit area (N4) |
| m3 Switch label | **ADDRESSED** | `<label htmlFor>` with `id` on `Radix.Root`. A test clicks the label |
| m4 `text-attention` | **ADDRESSED** | No `*-attention` class left in `apps/web/src` outside `features/sessions` |
| m5 docs | **ADDRESSED** | All six points are fixed. One new sentence is garbled (nit 1) |
| m6 Undo after Reset | **ADDRESSED** | `parseAccount` drops a side that names a deleted theme. A test covers it |
| m7 stale vs render bug | **ADDRESSED** | `notifyLazyFailure` and `LazyPane` split `lazy_chunk_failed` from `render_failed`. `isStaleChunk` is shared from `lib/lazy.tsx` |
| m8 dead code | **ADDRESSED** | `onRegistryChange`, `account.logout`, the palette `platform` prop and `navigate.ts` are gone. `TreeDrawer` has its `.catch`. knip is clean |
| m12 all CSS assets | **ADDRESSED** | `build-output.int.test.ts` joins every `.css` asset |

## Repros re-run

### I1

- **The built bundle.**
  - The only real `Function(` call is zod's probe. Other occurrences are grammar regex strings and a method name.
  - The only holder of the `Cloudflare` marker is `settings-2NqOiC5I.js`. Importing it with `Function` refused gives **0 attempts**.
  - `jitless:!0` sits at byte 86 683, before the first contracts schema at 86 977.
  - Only `csp-safe-zod.ts` imports a zod subpath, on the branch and on the merged tree, so nothing bypasses the `^zod$` alias.
- **Mutation A (alias removed).** The new test fails: `settings-Cx11V2JZ.js: expected '1' to be '0'`.
- **Mutation B (alias kept, `z.config` removed).** It fails the same way (`settings-DUBop9V8.js: expected '1' to be '0'`). The probe does catch the regression as the code is chunked today.
- **Mutation C (alias removed, zod forced into its own chunk with `advancedChunks`).** The test **passes**, which is a false green.
  - The chunk that holds zod has no schema, so importing it builds nothing.
  - Importing the schema chunk `settings-*.js` of the same build records **1 attempt**.
  - See N2.

### I2 and I3

These are covered in the status table. The four I2 scenarios (`rr-i2.test.tsx`) and the I3 two-press variant (`rr-i3b.test.tsx`) are green on e61b01b.

## I5 merge semantics

What I checked: code read of `lib/account-setting.ts:74,112-115,128-130` and `features/appearance/model.ts:99-125`, plus 6 scratch scenarios in `rr-i5.test.ts`, all green as predicted:

- **Stale-device add, remove and edit.** Correct. The implementer's 6 two-device tests and 3 unit tests cover them.
- **Edit racing a delete.** "A local delete applies only if the server copy still equals `base`", so an edit wins over a delete on either device. Verified in both directions.
  - Extra scenario: this device deletes a theme it had selected while the other device renames it. The theme comes back, and the selection stays reset to `night`. Nothing is lost.
- **When the base moves.** It moves on adoption (a load that returns a value) and on a successful save (`base = sent`). The save update is required: without it, this device's own saved theme would look like "added elsewhere" and a later local delete of it would be undone.
  - It does not move on a failed load, a `null` load, a conflict or a failed save.
  - A save that timed out but was applied anyway merges idempotently on the next load.
- **Reset, Undo and the retry limit.**
  - A stale device resets while the other device adds T1. T1 survives the reset save and the Undo. `customThemes` never becomes dirty, because Undo re-parses to equal JSON.
  - Two conflicts in a row → status `error`. The next change merges against the latest base, and t0–t4 are all kept.
- **Two devices adding the same id: the stale device's version wins silently.** This is N3. Ids derive from names (`newThemeId` slugs the name), so it is ordinary use, not "at once":
  - Two devices that each press Duplicate on Night Control get `night-control-copy` with different colours.
  - Measured: device A's `#101010` is gone, and A's dark side (`darkTheme: night-control-copy`) now shows B's `#202020`.
- **Other residuals (nits, documented or with no common ancestor).**
  - When the server has no document (home reset, unreadable row), the base stays the cached copy. A theme that only this device's cache holds is then dropped at its first conflict (measured: `x` lost). There is no common ancestor, and taking an empty base would instead resurrect themes the other device deleted, so I accept it. One line in `web.md` should say so.
  - At the 16-theme cap, this device's new theme is dropped after the merge with status `saved` and no notice. This is documented.
  - `sameTheme` compares with `JSON.stringify`. Every current construction path gives the schema's key order:
    - the editor's `{ id, ...{ name, base, roles } }`;
    - `presetRoles` in `THEME_ROLES` order;
    - zod output in shape order.

    A future `{ ...theme, id }` would make an unchanged theme look edited and undo deletes. A canonical comparison, or a test with reordered keys, would pin this.

## Lazy SessionScreen (lever 1)

- **First paint at `/`: unchanged.** `SessionListScreen` stays eager in `pane-renderers.tsx`. The initial bundle went from 192.9 to 189.7 KB. The two extra initial files are shared helpers of 0.1 and 2.9 KB.
- **Tests wait properly.** All three shell assertions on a session pane (AppShell, MobileShell, PaneHost) use `vi.waitFor`, and `test:unit` was green 3 / 3. M2's `SessionScreen` tests mount the screen directly, so they are unaffected (merged unit 2813 / 2813).
- **Stale chunk.** It is the same `LazyPane` path as Settings: an in-pane Retry plus a toast, and `render_failed` for a render bug.
- **Focus and URL.** The URL and the tab update first. The pane stays empty until the chunk arrives. The shell moves no focus into the pane, and `TabBar` only refocuses tab buttons after a close, so lazy loading changes nothing here.
- **N1 (Important): about 300 ms of blank pane on every activation of a session tab.** The cause:
  - `PaneHost` keys the pane by `tab.key` (`PaneHost.tsx:18,25`), so every tab switch remounts the pane.
  - `useRetryableLazy` creates a fresh `lazy(load)` per mount (`lib/lazy.tsx:75`).
  - So every remount suspends once, even with the chunk cached. React 19.3 then holds the reveal until 300 ms after the fallback commit (`FALLBACK_THROTTLE_MS = 300`, retry lanes, `react-dom-client.development.js:18200`).

  Measured outside `act`, as in a browser: the real shell with router, PaneHost and LazyPane, switching session a ↔ b.

  | Build | Per switch | Pane blank 20 ms after the click |
  |---|---|---|
  | e61b01b | **316, 316, 314 ms** | yes |
  | Eager `SessionScreen` (3c036f3 behaviour) | 24, 22, 22 ms (20 ms of it is the test's own sleep) | no |
  | Settings tab switch (pre-existing since the Settings LazyPane; I missed it in the final review) | 334–405 ms | yes |

  - The test bed runs inside `act`, which bypasses the throttle (13–36 ms). That is why no test saw it.
  - With M2, the session also subscribes 300 ms later on every switch.
  - **Fix (prototyped).** Keep the lazy component per loader at module level: a `WeakMap<loader, LazyExoticComponent>` inside `useRetryableLazy`. Replace the entry on `retry()`, and also on failure, so a pane remounted after a failure imports again.
    - Measured: **21–23 ms**, never blank, for sessions and Settings.
    - The 31 lazy and failure tests stayed green (`lib/`, `LazyPane`, `lazy-failure`, `PaletteHost`, `overlay-failure`, `CustomThemes.lazy`).
    - Every loader is already a module-level constant.
    - Pin: "a pane remounted after its chunk loaded does not call `load` again". `act` hides the timing, so pin the loader call count.
  - The same fix makes the split header's menu open without delay the first time when the account menu has already loaded (`LazyMenu` has the same per-instance `lazy`).

## P6 bundle risk, re-measured

| Build | Initial gzip |
|---|---|
| M3 e61b01b | **189.7 KB** (17 files) |
| M3 e61b01b + M2@eab6088 (Tasks 1a–17a) | **191.6 KB**. +1.9 KB: `runtime-*` +1.6 (protocol v2, reducer), `i18n-*` +0.3 (7 keys). The entry is unchanged at 125.4 KB gzip. The session chunk is 6.7 KB, lazy |
| For reference: the final review's trial (3c036f3 + M2@7d5892a) | 195.2 KB, and 190.5 KB with lever 1 |

Remaining eager vectors:

1. **M2 Tasks 24–29 strings.** The M2 plan adds about **68 keys** to the `sessions (M2)` block of `en.ts` and `fr.ts`, which is eager.
   - At about 47 B gzip per en + fr pair (measured), that is **about +2.5–3.5 KB**.
2. **Contracts and runtime for Tasks 17b–23** (rename, auto-name, export, fork / clone, idle release): about +0.5–1.0 KB.
3. **Eager glue:** `auth-api` logout clearing drafts, `rpc.newCommandId`, list changes. About +0.3–1.0 KB.
4. **P3's AI components** now land in the session chunk: about 0 eager, against +4.0 KB before lever 1.

**Estimate at P6: about 195–198 KB. Probability of exceeding 200: about 10–15 %** (it was > 85 % without levers). The remaining risk is M2 UI reached from an eager path:

- `SessionListScreen`, the shell, stores or runtime;
- or Radix overlays imported outside the `SessionScreen` subtree.

Levers left:

- Register M2's session strings with the session chunk (`registerCatalog`, as `settings-screen.ts` does): −2.5–3.5 KB.
- A lazy `MobileShell`: −1.7 KB.
- `zod/mini`.

## Implementer concerns

- **`isStaleChunk` reads `error.cause` one level deep. This is a test accommodation, and it is harmless.**
  - Without the `cause` clause, 6 shell-level tests fail, because vitest wraps a throwing mock factory.
  - Real browsers never need it:
    - Chromium, Firefox and Safari reject `import()` with the bare TypeError.
    - Vite's preload helper re-throws the original error.
    - `React.lazy` hands the rejection to the boundary unwrapped.
  - A real render error is classified stale only if its `cause` is itself a stale-chunk error. That happens only when the root cause is a gone chunk, so "pap was updated" is then right.
  - The production path (a top-level message) stays covered by `lazy-parts`, `LazyPane` and `lazy.test`.
- **The probe accepting `w-full`: not a meaningful weakening.**
  - I ran the probe with "the element only".
  - Every `w-full` control carries the class on the interactive element itself: Select trigger, TextField, Collapsible trigger.
  - The only ancestor use is the Slider root, which is where Radix takes the pointer, so that is legitimate.
  - The real gap is elsewhere, see N4.

## Open items

| # | Severity | Item | Fix |
|---|---|---|---|
| N1 | **Important**, before merge | About 300 ms of blank pane on every switch to a session tab (Settings: same, pre-existing), caused by a fresh `lazy()` per remount and React's retry throttle | A per-loader lazy cache in `useRetryableLazy`, evicted on failure and on retry, plus a loader-call-count test |
| N2 | Minor, before the rebase | The I1 probe can give a false green: it imports only the chunk that holds zod's probe. If rolldown moves zod into a chunk without schemas (plausible as M2 adds zod consumers), it reports 0 while the page violates the CSP (mutation C) | Also assert that `jitless:!0` sits in the holder chunk (catches A, B and C), or also probe the chunk that holds the `reserved theme id` schema |
| N3 | Minor | I5 residual: ids are name slugs, so two devices that each add "Night Control copy" collide. The stale device's version silently replaces the other's theme, and the other device's selected side then shows foreign colours | When an add collides with a server theme of different content, give the local one a fresh id (`newThemeId` over the server and local ids) and move this device's side selection with it. Reword `web.md:17`: the cause is "the same name", not "at once" |
| N4 | Minor (gallery-only today) | The Checkbox's 44 px classes sit on a non-interactive `div` (`Checkbox.tsx:17-19`). The real hit area is the 16 px box plus the label text. The probe accepts any class on the parent or grandparent (`Gallery.test.tsx:103`), so m2's `min-w-11` there satisfies the probe without enlarging the target | Make the row a `<label>` wrapping the box (as m3 did for Switch). Let the probe accept an ancestor only if it is a `label` or the Slider root |
| nit 1 | — | `docs/agents/web.md:50`: the build-output sentence is garbled ("…markdown), and the zod chunk loading without an eval attempt absent from every initial file"), and it omits the session-screen pin (`"data-failure"`) | Reword |
| nit 2 | — | No common ancestor when the server has no document: a theme held only in the cache is dropped at the first conflict | One line in `web.md` |
| nit 3 | — | At the 16-theme cap, this device's new theme is dropped with status `saved` and no notice | A toast, or carry |
| nit 4 | — | `sameTheme` is sensitive to key order (see I5) | A canonical comparison or a test with reordered keys |
| nit 5 | — | `LazyMenu` remounts its trigger when `asked` flips, so keyboard focus drops to `body` if the chunk fails. This is pre-existing, from the old Suspense code | Carry to the browser e2e |

## Rebase hints for the M2 merge

They are recorded only in gitignored files:

- the SDD ledger, `.superpowers/sdd/…/progress.md`, last line: `Toaster regionLabel`, `merge` 4th base arg, `LazyPanel` moved to `lib/`;
- the implementer's report, which also lists `PANE_RENDERERS.session` through `LazyPane`.

The tracked plan's "Merge order and conflict notes" (`docs/plans/2026-10-11-m3-design-system.md:10859`) does not carry them. They are still correct, and the trial merge needed none of them yet: M2@eab6088 mounts no `Toaster` and creates no account document. Add these alongside them:

- `build-output.int.test.ts` pins the session chunk with the marker `"data-failure"`. It fails closed, so if M2 Task 24 or 25 moves the failure line out of the session subtree, the pin turns red at the rebase. Pick another marker that only the session screen has.
- Any M2 shell-level test that reads a session pane must `vi.waitFor` it, because the session screen is a lazy chunk.
- M2's new tests that mount `Toaster` need `regionLabel`.
- P6 lever: register M2's `sessions.*` strings with the session chunk instead of the eager block.

## Carried, by ruling (unchanged)

- m9 (multi-user cache clearing)
- m10 (Settings catalog split at M5)
- m11 (i18n disjointness test at P7)
- the triage C rows (P1–P7, M4, M11, browser e2e)

---

# Round 2 — fix batch e61b01b..ebb2a77 (7 commits)

Reviewer: Opus, read-only on the worktree. Scratch only:

- `/tmp/claude-1000/m3-final-review/repo` at ebb2a77 (detached, clean): the gate.
- `/tmp/claude-1000/m3-rr2/exp` at ebb2a77: timings, mutations, bundle variants. Sources restored after each one; only the scratch tests are left there (`rr*-*.test.ts[x]`, copies in `/tmp/claude-1000/m3-rr2/tests/`).
- `/tmp/claude-1000/m3-rereview/merge`, branch `rr2-trial`: ebb2a77 + `feat/m2-sessions@1fea310`, both merges clean.
- Logs and scripts: `/tmp/claude-1000/m3-rr2/{logs,scripts}/`.

## Verdict

**Merge-ready.** N1 is fixed and measured. N2–N4 and nits 1, 4 and 5 are fixed and pinned by tests (every pin checked by mutation). The gate is green on the branch and on the trial merge with M2.

There is one new Minor item, **R2-1**. The cap-drop notice (nit 3) is a heuristic, and it misfires both ways:

- It shows a false error toast in the very flow it recommends.
- It misses two real drops.

The exact fix is about 10 lines, and I prototyped it. Do it before the merge because this round introduced it, but it does not block. The other items are nits or can be carried.

Counts: **0 Critical, 0 Important, 2 Minor (R2-1, R2-2), 4 nits (R2-3 to R2-6).**

## Gate

| Step | ebb2a77 (scratch, `--frozen-lockfile`) | ebb2a77 + M2@1fea310 |
|---|---|---|
| lint · format:check · typecheck · knip | exit 0 · 0 · 0 · 0 | exit 0 · 0 · 0 · 0 (no hand resolution needed) |
| test:unit | 212 files, **2095 / 2095** | 269 files, **2834 / 2834** |
| test:int (`env -i PATH HOME LANG=C.UTF-8 CI=1`) | 25 files, **210 / 210** | 39 files, **262 / 262** |
| build · smoke | exit 0 · ok (prompt → approval → tool output → agent_settled, SIGTERM 0, 1 worker gone) | exit 0 · ok |
| budgets | **191.4 KB / 200**, 17 initial files | **193.3 KB / 200**, SessionScreen chunk 6.7 KB |

No changed file is over 400 lines. The largest is `model.ts` at 297.

## Status per item

| Item | Status | Evidence (my runs) |
|---|---|---|
| N1 300 ms blank pane | **ADDRESSED** | Timings below. Loader-once and evict-on-failure tests exist and fail under mutation |
| N2 vacuous I1 probe | **ADDRESSED**, nit R2-3 | Mutation C is now red. A correct build with zod split manually is a false red (fail-closed) |
| N3 same-id adds | **ADDRESSED** | Repro now keeps both themes. Selection, re-id and canonical compare checked below |
| N4 Checkbox target | **ADDRESSED** | The row is the `<label>` and toggles once per press. The probe now refuses the old `div` |
| nit 1 `web.md` | **ADDRESSED** | Reworded. The session pin `"data-failure"` is listed |
| nit 2 cache-only themes | **PARTIAL** → R2-2 | Survives a conflict only when this device changed its theme list. A reload, a reconnect or a non-theme change still drops it |
| nit 3 cap notice | **ADDRESSED with defects** → R2-1 | False positives on load and reconnect; misses on collision and on a shared name |
| nit 4 key order | **ADDRESSED** | Canonical compare is order-independent at both levels |
| nit 5 LazyMenu focus | **ADDRESSED** | Refocus removed → `overlay-failure` "account menu…" fails |

## N1

**Timing.** Measured outside `act` on the real shell (router, PaneHost, LazyPane), same harness as round 1 (`rr-shell-timing`, `rr-settings-timing`), 7 switches, 2 runs:

| Switch | e61b01b (round 1) | ebb2a77 | Eager screen (reference) |
|---|---|---|---|
| session a ↔ b | 314–316 ms, blank | **20–27 ms, never blank** | 22–24 ms |
| session ↔ Settings | 334–405 ms, blank | first load 431–466 ms (cold import + throttle, once), then **26–98 ms, never blank** at +20 ms | 24–173 ms |

- The 26–98 ms left on Settings is render cost. An eager `SettingsScreen` measures the same or slower in happy-dom.
- **Cache semantics** (`lib/lazy.tsx:67-110`):
  - Every loader passed to `useRetryableLazy` is a module-level constant: `loadSettings`, `loadSession`, `loadMenu`, `loadEditor`, `loadTreeDrawer`, `loadInboxDrawer`, `loadShortcutsHelp`, `loadTabSwitcher` and `loadPalette`.
  - A rejected import evicts its entry inside the `.catch` before React sees the rejection. The identity check keeps a newer entry.
  - `retry()` deletes the entry and builds a fresh `lazy()`.
  - A resolved lazy whose component throws stays cached. That is correct: the module is fine, and Retry replaces it anyway.
  - A never-settling import stays pending. That matches the browser's module map, so it is no regression.
- **Mutations** on `lazy.test`, `LazyPane`, `lazy-failure`, `PaletteHost`, `overlay-failure` and `CustomThemes`:

  | Mutation | Result |
  |---|---|
  | `lazy(load)` per mount | "imports once across remounts" fails |
  | No eviction on failure | "imports again when the first import failed" fails |
  | `retry()` reuses the shared entry | green: redundant with the eviction, not a gap |
  | Both of the last two | 4 failures, including LazyPane Retry |

## N2

`build-output.int.test.ts -t eval`, mutations in `vite.config.ts` / `csp-safe-zod.ts`:

| Mutation | Result |
|---|---|
| A alias removed | red (`settings-*.js` lacks `jitless`) |
| B `z.config` removed | red |
| **C alias removed + zod in its own chunk (`advancedChunks`)** | **red** (`zodonly-*.js` lacks `jitless`): round 1's false green is gone |
| E `z.config` removed + zod own chunk | red |
| **D correct code + zod own chunk** | **red, but the page is CSP-safe** (probe: 0 attempts in `zodonly-*.js` and in the schema chunk, which holds `jitless:!0`) → R2-3 |

- **Why D is red.** A manual rule separates `src/csp-safe-zod.ts` from `node_modules/zod`.
- **Automatic chunking keeps them together.** Every importer of zod goes through the wrapper, so both modules have the same importer set.
- **So D needs a deliberate vendor split.** It fails closed.

## N3 and the theme nits

Scratch `rr2-n3.test.ts` (two devices on `createAccountDocument` + `mergeAccount`, as round 1):

- **Round 1 repro (both press Duplicate on Night Control, A then stale B).**
  - The server keeps `night-control-copy:#101010` (A's) and `night-control-copy-2:#202020` (B's).
  - `darkTheme` stays A's `night-control-copy` → A's colours.
  - After its next sync, A holds both.
- **Both selected their own copy as dark.** The server's `darkTheme` is B's `night-control-copy-2` (`#202020`), and B's state follows.
  - A adopts B's later choice and keeps its own theme intact. That is last-writer-wins on an account field, the documented rule for scalars.
- **Same collision found on a plain reload instead of a conflict:** same result.
- **Re-id skips ids that are already taken.**
  - With `x` and `x-2` on the server → `x-3`, and the side follows.
  - With a local `x-2` → `x-3`.
- **Canonical compare.** Reordered top-level and nested `roles` keys count as neither an edit nor an add. A real colour change is still an edit.
- **Mutations.** Removing the side remap makes the 2 collision tests fail.
- **Cache-only themes (nit 2), server with no document.**

  | Scenario | Result |
  |---|---|
  | S1: the implementer's case (B writes first, then A adds a theme) | `t0` kept |
  | **S2:** B writes first, then A changes only `mode` | **`t0` lost** |
  | **S3:** A changes nothing, B writes, A's socket reopens | **`t0` lost** |
  | S4: A's page reloads after B wrote | `t0` lost: a document exists, so there is no common ancestor; acceptable |

  → R2-2.

  - A prototype that marks `changed(parse(null), local)` dirty on a null load fixes S2 and S3. It is a behaviour change, though: every device with a non-default cache then writes on first contact. It turns 3 existing tests red (ordering, and "while the reset is being saved…"), so it needs a ruling, not a patch.
- **Cap notice (nit 3).** Scratch `rr2-cap.test.ts` on the real controller:

  | Case | Result |
  |---|---|
  | FP1: the app opens with a stale cache of 16 themes, and another device swapped one at the cap (delete t5, add t99) | **error toast, 0 writes** |
  | FP2: same swap, seen at a socket reopen | **error toast** |
  | MISS1: cap + same-id collision. B's re-id'd copy is cut, but its old id is still present (as A's theme) | **no toast** |
  | MISS2: cap drop of a theme that shares its name with a kept one (a second "Night Control copy") | **no toast** |
  | The implementer's plain drop · quiet case | toast · quiet |

  - **Cause.** `dropsLocalTheme` compares the whole local list to the merged one. It also runs on every load, where `dirty` is empty and a stale cache is not a change. The name check hides re-ids and duplicate names.
  - **Exact detector (prototyped).** A merge that has `customThemes` dirty and builds a list longer than 16 before `parseAccount` cuts it.
    - The server's ≤ 16 themes come first, and local edits replace them in place. So everything cut is this device's add, a resurrection or a re-id'd copy.
    - With `mergeCutsThemes(server, local, dirty, base)` in `model.ts` called from the controller, FP1 and FP2 are silent and MISS1 and MISS2 toast.
    - The implementer's two cap tests and all other appearance tests stay green (132 / 136; the 4 red were my assertions of the old behaviour).

## N4

- **Clicks.** One toggle per press on the box, the text and the row itself. Disabled: none. These are happy-dom results.
  - In browsers, a click whose target is the labelled control is not re-dispatched by the label.
  - Radix stops propagation only inside a `<form>`.
  - The component is gallery-only today, so the browser check goes to the e2e carry.
- **Mutations.**
  - The old Checkbox fails the new controls test and the gallery probe (`Checkbox: <button>` ×2).
  - Removing `data-slot="slider-control"` fails the probe (`Slider: <span>`).
- **Audit of every control that passes through an ancestor.** There are exactly 3:
  - 2 Checkbox `button[role=checkbox]` via a `label` whose `.control` is that button;
  - the Slider `span[role=slider]` via its `Radix.Root`.
- **`slider-control` is legitimate.**
  - It sits on the Radix Slider root, which takes `pointerdown` on its whole box (`h-5 w-full`, `pointer-coarse:h-11`).
  - Only `Slider.tsx` uses it.
  - It is a magic attribute that could be pasted onto a wrapper, though. Optional hardening: R2-5.

## Bundle

Exact initial gzip (level 9, as `check-budgets.ts`):

| Build | Initial | Δ vs ebb2a77 |
|---|---|---|
| e61b01b | 194 258 B (189.7 KB) | −1 726 B |
| **ebb2a77** | **195 984 B (191.4 KB)** | — |
| **V1: `newThemeId` in a new `theme-ids.ts`** (imports only `PRESET_THEME_IDS`); `theme-io.ts` re-exports it; `model.ts` imports it | **194 996 B (190.4 KB)** | **−988 B** |
| V2: V1 + toast text in a lazy module that imports `i18n` | 195 585 B, 19 files | −399 B (chunk reshuffle: a `rolldown-runtime` chunk appears) |
| V2c: V1 + text in a lazy module without imports, locale passed in | 194 835 B | −1 149 B |

- **Where the +1.7 KB came from.** `index.js` +1 544 B and `i18n` +170 B.
- **The `index.js` growth is mostly `theme-io.ts`.** Importing it from the eager `model.ts` moved the whole module there, along with `download-file.ts`, `parseThemeFile` and its `CustomTheme.omit` schema; `not_json` and `createObjectURL` now sit in `index-*.js`.
- **V1 puts them back in `SettingsScreen`.** It changes 4 lines plus 1 small file. **Do V1.**
- **Skip the text move.** It saves only 0.16 KB, and it bypasses the catalogs and their coverage tests.

## P6 estimate

- **Measured today.** The trial merge with M2@1fea310 is **193.3 KB** (+1.9 KB over the branch: the same M2 delta as round 1).
- **Remaining eager vectors (unchanged).** About +3.3–5.5 KB:
  - M2 Tasks 24–29 strings: about 68 keys, +2.5–3.5 KB;
  - contracts and runtime: +0.5–1.0 KB;
  - glue: +0.3–1.0 KB.

| Path | Estimate at P6 | P(> 200 KB) |
|---|---|---|
| As is | **about 197–199 KB** | **about 25 %** (was 10–15 % in round 1) |
| With V1 | about 196–198 KB | about 15 % |
| With V1 and M2's `sessions.*` strings in the session chunk (`registerCatalog`) | about 193–195 KB | < 5 % |

Further levers: a lazy `MobileShell` (−1.7 KB) and `zod/mini`.

## Rebase notes (plan, "Rebase hints from the final review (round 2)")

**All the hints are there.** That covers every hint from round 1:

- the ledger's three: `Toaster regionLabel`, `merge` 4th arg, `LazyPanel` in `lib/`;
- `PANE_RENDERERS.session` through `LazyPane`;
- the `"data-failure"` pin, which fails closed;
- `vi.waitFor` on session panes;
- the P6 strings lever.

The section also carries the final review's P7 exclusions, the migration stamp, `sideEffects`, `ApprovalAnswer` and the P3 musts.

**Checked against the merged tree:**

- `regionLabel` is required (`Toast.tsx:58`).
- `"data-failure"` is pinned at `build-output.int.test.ts:204` and sits in `SessionScreen.tsx:80`.
- `"sideEffects": false` is set in `packages/contracts/package.json`.
- `ApprovalAnswer` is a value + type in contracts (`policy.ts:7-8`) and a type in `@pap/ui`.
- Migrations: M2's newest is `202610110100_policy`, which sorts before `202610111000_settings`, so no re-stamp is needed.

**Accuracy nits (R2-4):**

- **`literal-coverage.ts` has no `M2_OWNED_UNTIL_P7`.** Its copy is the `features/sessions/` alternative inside `SKIPPED` (line 26). P7 must drop only that alternative: the regex also skips tests, `testing/` and the gallery.
- **A fourth place.** `scripts/class-coverage.test.ts:69-70` imports the constant, so it is also edited at P7.
- **Missing hint: a dev home made by the M3 branch will not open after the rebase.** It has `settings` applied and not `policy`, so `migrate.ts:119` refuses: "migration 202610110100_policy sorts before an applied migration". Reset that worktree's `PAP_HOME`. Smoke and tests use fresh homes and are unaffected.

## Open items

| # | Severity | Item | Fix |
|---|---|---|---|
| R2-1 | **Minor**, before merge (cheap, introduced this round) | **The cap notice misfires both ways.**<br>• It shows an error toast on load and reconnect when another device swapped a theme at the cap, and the toast tells the person to delete a theme.<br>• It stays silent when the cut theme is a re-id'd collision or shares a name. | Replace `dropsLocalTheme` with "`customThemes` dirty and the merged list > 16 before `parseAccount`" (prototype: `mergeCutsThemes` in `model.ts`). Pin FP1 and MISS1 |
| R2-2 | Minor, carry or rule | Cache-only themes (server with no document) survive only a conflict on a theme change. A reload, a reconnect or a non-theme change first adopts the other device's document (S2, S3) | Either a ruling to write the cached copy on a null load (behaviour change; 3 tests to adapt), or one line in `web.md` stating the narrow guarantee |
| R2-3 | nit | The N2 text check gives a false red on a correct build whose manual chunk rule separates `csp-safe-zod.ts` from zod (mutation D) | Optional: probe the chunk holding `reserved theme id` instead of the text check (catches A, B, C, E and passes D), or say in the test comment that a vendor split must keep the wrapper with zod |
| R2-4 | nit | Rebase hints: the `literal-coverage.ts` wording, the 4th site (`class-coverage.test.ts`), and the M3 dev home refused after the rebase | Three lines in the plan |
| R2-5 | nit | The probe trusts any `label` or `[data-slot=slider-control]` ancestor | Optional: require `label.control === el`, and `role=slider` for the slider slot |
| R2-6 | nit (bundle) | +1.0 KB eager from `theme-io.ts` | V1 (`theme-ids.ts`) |

Carried, by ruling (unchanged): m9, m10, m11, the triage C rows. Browser checks of the Checkbox label and the 300 ms throttle stay with the e2e carry.
