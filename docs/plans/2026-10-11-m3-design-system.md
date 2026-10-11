# pap M3: design system and app shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2026-10-11, before dispatch.** This plan absorbs the Opus red-team review (`.superpowers/redteam-m3.md`, findings M3-RT-01…41), the owner decisions of 2026-10-11 (`.superpowers/owner-decisions-2026-10-11.md`) and the M2 ⇄ M3 cross-plan agreements (`.superpowers/m2-m3-cross-plan-agreements.md`, quoted as "agreement n"). Every task's former list of risks awaiting a ruling is now a **Rulings (pre-dispatch)** list; the same rulings are numbered M3R1… in `.superpowers/rulings-m3.md`. Browser e2e (former Tasks 29–31) is removed and deferred (owner C1). Tasks 1, 16, 17 and 19 are split (1a/1b, 16a/16b, 17a/17b, 19a/19b); Task 10b (markdown and code highlighting, owner R3-1) is new. Every other task keeps its number.

**Goal:** Turn DESIGN.md (spec B, validated; contrast amended by ADR 0012) into code: the full Night Control token set with three themes and three densities, owned Radix primitives, the first AI components with lazy-loaded markdown and code highlighting, the logo, appearance settings stored per account (compare-and-set) and per device, keybindings with `when` clauses and an editor, the Cmd+K palette, the decision-25 app shell on desktop and phone, `/dev/ui`, en + fr everywhere. Every check of M3 runs headless (unit and integration tests); the Playwright journeys, the container runner and visual regression are deferred (owner C1, like decision 36).

**Architecture:** `packages/ui` owns every visual decision: `tokens.css` maps the DESIGN.md custom properties (`--bg`, `--surface`, `--agent`…) scoped by `[data-theme]` and `[data-density]` onto Tailwind 4 utilities (`utilities.css` holds the variants, utilities and keyframes), and the primitives and AI components take a `variant` and a `size`, never a `className`. The web app gains three feature folders (`appearance`, `commands`, `workspace`) and a shared `lib/`, and `routes/` becomes the shell that composes them: rail, top bar, open-item tabs, splittable panes, ⌘B tree drawer, Inbox drawer, palette, phone bottom nav. Account-scope settings (theme, fonts, labels, grid, rail, avatars, tool detail, keybindings) live in a new daemon `settings` module behind two RPC methods; a write carries the revision it was based on (compare-and-set), and the client merges and retries once on a conflict. Device-scope settings (density, sizes, motion, chat width) and the language live in `localStorage`. A blocking external boot script, emitted by a Vite plugin, applies the cached appearance before first paint without breaking the strict CSP (R74). The palette, the Settings screen, the shortcuts help, the theme editor, the markdown renderer and the code highlighter load lazily, behind a boundary that survives a stale chunk.

**Tech Stack:** React 19 + React Compiler, Vite 8, Tailwind 4.3.3 (`@theme inline`, `@utility`, `@custom-variant`), `radix-ui` (unified package), `cmdk`, `lucide-react`, `react-markdown` + `remark-gfm` (lazy), `shiki` with its JavaScript regex engine (lazy, no WebAssembly), TanStack Router, zustand, zod 4 (contracts), `node:sqlite` (daemon `settings` module), Vitest 5 + happy-dom, `@tailwindcss/node` (class-coverage gate), `babel-plugin-react-compiler` (compiler gate). No browser runner in M3.

**Spec:** `DESIGN.md` (spec B, binding: decision 33; amended by ADR 0012 in Task 1a), `docs/specs/2026-10-10-C-architecture.md` §7 (frontend) and §8 (gates), `docs/specs/2026-10-10-A-product-scope.md` §5.3, `docs/research/decisions-log.md` decisions 11, 21, 25–28, 32, 33, 36 (the 2026-10-11 owner decisions are appended there by M2's plan fix, agreement 12), the validated screens in `docs/design/explorations/05, 08, 12`, `docs/plans/roadmap.md` (M3), `docs/research/m0-m1-rulings.md`, `docs/spikes/s6.md`. Reference code read for this plan (read-only clones under `/home/ubuntu/Workspace/soulkyu/_refs/`): T3 Code and Orca, cited per task as `T3:` and `Orca:`; pi-web (`/home/ubuntu/Workspace/soulkyu/pi-web`, read-only) cited as `pw:`.

## Backlog rulings absorbed

| Ruling | What this plan does | Task |
|---|---|---|
| R120 | **Owner M3-Q1 = option (b).** ADR 0012 amends DESIGN.md §3 and §7.4 (Task 1a): day focus ring `#EA580C` (night and high contrast keep the you fill); `--control-border` for inputs and controls, day `#8F877A`, night `#6B6485`, high contrast `#8A8A8A`, while the hairline `--border` stays decorative; the night approval title `#F472B6` through a new `--attn-title` token; `--attn-ink` `#110F18` on pink fills in night and high contrast. `focus-ring`, `control-border` and `attn-title` are theme tokens (presets, custom-theme derivation, boot cache); `tokens.test.ts` asserts every value and its contrast ratio. The theme-selector specificity trap and per-role inks are fixed too: every theme selector has the same specificity and each role has its own ink. | 1a, 13 |
| R129 | The two reducer items (linear snapshot reduce, no content dedup for `role:none` refs) live in M2-owned `apps/web/src/stores/session-reducer.ts`: post-merge task P5, which first checks whether M2's entry-id rows already resolved them. The `/dev/ui` screenshots of DESIGN §14 are deferred with the browser e2e (owner C1). | P5, deferred |
| R125 | Agreement 3: stream keying `${stream}:${key}` is parked until the first second subscription stream (M4 sessions list or M10 inbox); hidden-tab reconnect throttling is M12. Neither M2 nor M3 adds a second stream (M3's settings are read on connect and written with compare-and-set, no live sync). HMR: every module-level listener M3 adds (`matchMedia`, the key dispatcher, the appearance controller) disposes on `import.meta.hot`; shell tests mock the runtime singleton. | 15, 17a, 19b |
| R118 (T26 checks) | Vite proxy `ws: true` and fonts never inlined as `data:` stay pinned (existing tests kept through the font move). The Safari 16.4 CSP check for the WebSocket (`connect-src 'self'`) is **not** done in M3: no browser runs (owner C1), and Playwright's WebKit is current WebKit, not Safari 16.4, so even the deferred journeys would not prove it (M3-RT-36). It stays open; the explicit-`wss:` fallback is a daemon change if a real Safari 16.4 refuses the socket. | 1b, deferred |
| R122 / R128 "@pap/ui through the Compiler" | A compiler gate transforms every `.tsx` of `packages/ui` and `apps/web` with `babel-plugin-react-compiler` and fails on any `CompileError`/`PipelineError`; a Vite test proves the build pipeline compiles `packages/ui` files. | 2 |
| R128 reactive locale switch | `useT()` / `useLocale()` on `useSyncExternalStore`; Settings › Language switches without reload (per device, owner R3-3). | 3, 24 |
| R128 i18n of server cause/notice texts | `serverText()` translates the daemon's current English notice and cause sentences (en + fr); wiring into the M2-owned reducer and a code-based contract are post-merge task P4. | 3, P4 |
| Safari IME keyCode 229 | `cancelsComposition()` (isComposing or keyCode 229, pw: `lib/stacked-dialog.ts`) guards dialog Escape, the submit shortcut and the key dispatcher. | 6, 8, 16a |
| R121 mono-uppercase button labels | Buttons and HUD labels use the `label-hud` utility (mono, 600, 0.12em, `text-transform: var(--label-transform)`), switchable in Settings; the DOM keeps sentence case so selectors never depend on CSS text-transform (M2's ApprovalDialog does the same, agreement 6). | 1a, 5, 10 |
| on-fill per role | `--agent-ink`, `--you-ink`, `--attn-ink` per theme (`--attn-ink` `#110F18` in night and high contrast, ADR 0012); `on-fill` stays an alias of `--you-ink` until P1. | 1a |
| theme selector specificity | A test parses `tokens.css` and allows only `:root, [data-theme="night"]`, `[data-theme="day"]`, `[data-theme="hc"]` and the no-JS fallback `:root:not([data-theme])`. | 1a |
| R53 (S6) | AI components ported with attribution (Message actions/branch, Reasoning), `THIRD_PARTY_NOTICES.md` plus the canonical Apache-2.0 text in `LICENSES/Apache-2.0.txt`, Collapsible primitive through ADR 0010. | 7, 9, 10 |
| R51 / decision 36 | The M1 Task 27 browser journey that decision 36 moved to M3 is deferred again (owner C1, 2026-10-11): M3 adds no Playwright, no container runner and no CI `e2e` job, and the M1 guards of `scripts/ci-config.test.ts` stay unchanged. | deferred |
| R74 | No inline script anywhere: the pre-paint boot script is an external hashed classic script; code highlighting uses shiki's JavaScript regex engine, so the CSP needs no `'wasm-unsafe-eval'`; the build-output test keeps proving both. | 14, 10b |
| R105 / R65b | Account settings are mutations (`idempotent: false`, `commandId`) written with compare-and-set (`baseRevision`); a save that ends in `timeout`/`connection_lost` is never re-sent by itself; a re-sync re-reads before it writes. | 12, 15, 17b |

## What this plan explicitly defers

- **To post-merge tasks P1–P7** (run once M2 and M3 are both on `main`, order P7 → P3 → P2 → P1 → P4 → P5 → P6, agreement 14; see "After both milestones merge"): running the new gates over M2's files, adopting the shell landmarks, AI components, markdown and key bindings in M2's session screen, promoting M2's dialog shells / status bar / widgets / custom panel into `packages/ui`, removing the M1 token aliases, code-based server texts, R129's reducer items, re-measuring the bundle budget.
- **Browser e2e (owner C1, like decision 36):** the former Tasks 29–31, that is Playwright in the official container (`playwright run-server`, podman locally, docker in CI), the owner / shell / phone journeys on Chromium and WebKit, the CI `e2e` job, visual regression of `/dev/ui` (3 themes × 2 densities), the standalone gallery build only they needed, and the runtime "clean screen" checks (zero CSP violations and console errors in a real browser, measured 44 × 44 px targets). The M1 guards in `scripts/ci-config.test.ts` (no browser runner, exact CI job list) stay as they are. The full text of the removed tasks is in git at `02d81da` (this file before the revision). Whoever revives them applies M3-RT-17 (rewrite the named `ci-config.test.ts` assertions explicitly, never delete a guard), M3-RT-18 (no `npx` in the container: mount the lockfile-verified `playwright-core` read-only, `--shm-size=1g`, `--user pwuser`, pull the image by digest), M3-RT-34 (register the container cleanup before `run`, a Playwright `globalTimeout`, document the run-server exposure), M3-RT-35 (the 44-px probe skips `aria-hidden`, `opacity: 0` and `pointer-events: none` elements) and M3-RT-33 (the gallery entry imports no `csp-safe-zod`; `vite.gallery.config.ts` sits in a tsconfig `include`). What M3 checks instead, without a browser, is listed under "Exit criteria".
- **PNG icons** (favicon 16/32, Apple touch 180, PWA 192/512 maskable): with M12's manifest; rendering them needed the browser container. Until then Safari shows no tab icon (SVG favicon only); Task 11 ships the SVG sources.
- **Tool-specific renderers** (edit diff, codemode calls, MCP results): M6, on DiffView (R50), agreement 9. M3's `ToolCard` stays generic; markdown and code highlighting in messages are M3's (Task 10b); M2 renders plain text with native `<details>` until P3.
- **Live cross-tab or cross-device refresh of account settings** (a `storage` event or a settings stream): not in M3. Compare-and-set already prevents lost updates between tabs and devices; another tab's change shows at its next connect or reload. A live settings stream would be the second subscription stream of R125.
- **To later milestones**, built on M3's primitives: project switcher and project groups (M4), FTS5 transcript hits in ⌘K (M4), approval scopes wired to the policy (M5), DiffView (R50) and the tool renderers on it (M6), terminal/diff/review pane kinds (M8/M9), CheckpointBanner and CompareColumn (M9), TriggerVerdict and the Tasks board (M10), agent avatars in the rail, EventCard, PendingRequestsStrip, PromptChips, the Inbox stream and agent status panel (M11), PWA manifest, PNG icons, service worker and push (M12), the first-run stepper of screen 12 (M7). The rail, Inbox drawer and phone "Agents" tab ship with empty states.
- **Not in v1 at all** (DESIGN §13): custom CSS, full cross-device sync.

## Global Constraints

Copied from the specs and the binding rulings (source in brackets). Every task implicitly includes them.

- Node 24: "Boring tech. TypeScript on Node 24, SQLite, React; no Effect, no SSR." [A §3] · `engines.node` `>=24.14 <25` [R44]
- File size: "400 lines per file at most. No baseline, no exceptions." [C §1.4.2] — enforced by ESLint `max-lines` and `scripts/source-guards.ts` for code, and by AGENTS.md for every file, CSS included (hence `tokens.css` + `utilities.css`, M3-RT-20) [R64c]
- Module boundary: "A module imports only `contracts`, `kernel` and other modules' `index.ts`." [C §1.4.1]
- RPC handlers: "An RPC handler decodes the request, calls one service method and maps typed errors. Nothing else." [C §1.4.3]
- Permissions: "Every RPC method declares a permission in `contracts`. A missing permission is a type error." [C §1.4.4]
- Packages: "No fourth package until a real need appears." [C §1.4.6]
- UI look: "Primitives in `packages/ui` own their look: no raw colours, no arbitrary values." [C §1.4.5] · "Each primitive owns its look: callers pick a `variant` and a `size`, never a `className` restyle." [DESIGN §9.1] · `pap/no-raw-colors` flags every hex or `rgb()`-style literal in non-test `packages/ui/src/**` and `apps/web/src/**` TypeScript; the only files exempt are the colour-data and colour-math files listed in its `ignores` (Task 1a: `presets.ts`; Task 13: `contrast.ts`, `derive.ts`), each pinned by tests. [eslint.config.js, M3-RT-02]
- "No gradients and no glow, ever." [DESIGN §1] · "Surfaces never cast shadows." [DESIGN §3.4] · "Nothing repaints continuously." [DESIGN §7.2]
- Focus: "A 2 px solid `--you-fill` outline with a 2 px offset on `:focus-visible`. It is never removed." [DESIGN §7.4], amended by ADR 0012: the outline colour is `--focus-ring` (the you fill in night and high contrast, `#EA580C` in day).
- Touch: "Under `pointer: coarse`, every interactive target is at least **44 × 44 px**, whatever the density." [DESIGN §5] — checked in M3 as classes (Task 28's probe), not measured in a browser (deferred).
- Fonts: "self-hosted as woff2 in `packages/ui`. No font CDN at runtime" [DESIGN §4]
- Icons: "lucide, with a 1.5 px stroke, in `currentColor`… Every icon-only button has an accessible label and a tooltip; the native `title` attribute is not used." [DESIGN §7.1]
- Copy: "Every string goes through the internal i18n layer; no string is concatenated around variables." · "Never overclaim" · "No exclamation marks in system copy." [DESIGN §11] · UI languages en + fr [A §5.3, C §7.3]
- Browser floor: "The Safari / iOS 16.4 floor, pinned by a test." [C §7.3] — no CSS or JS above Safari 16.4 (no native CSS nesting in shipped CSS, no `light-dark()`, no `field-sizing`, no RegExp `v` flag) [R50, S6]
- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'` — no inline script, no `eval`, no WebAssembly (`'wasm-unsafe-eval'` is not granted); relaxing a directive needs an ADR [R74]
- Zero telemetry: nothing loads from the network at runtime [C §9.4, DESIGN §4]; model markdown never loads an image or any other resource (Task 10b).
- Errors: "Errors carry a stable code and a fixed message, with no user content and no secrets." [C §4.1]
- Mutations carry a `commandId` (`idempotent: false`); reads are `idempotent: true` [R65b]; a mutation that ends in `timeout` or `connection_lost` is never re-sent by itself [R105]
- Lint discipline: the only directive accepted is `eslint-disable-next-line <rule> -- <reason>` [R64b, AGENTS.md]
- Supply chain: dependencies pinned exactly with `pnpm add -E <pkg>` (no range) [R56]; `minimumReleaseAge` 3 days: pnpm picks the newest version old enough, and a version too young is waited for, never forced (no `--config.minimumReleaseAge=0`, no edit of `pnpm-workspace.yaml`); record the version it chose in the commit message; no new build script unless listed in `onlyBuiltDependencies` / `ignoredBuiltDependencies` [R36]
- Bundle (owner R3-5, agreement 10): target ≤ 200 KB gzip for the initial JavaScript and CSS. Heavy screens load lazily (palette, Settings with all its sections, shortcuts help, theme editor, markdown renderer, highlighter). `apps/web/src/build-output.int.test.ts` checks the initial size against `budgets.json` in every `pnpm test:int`: a task whose build crosses the current value raises `initialBundleGzipKb` to a provisional value (measured × 1.05, rounded up to the next KB) in its own commit, with the body `budget: provisional <n> KB (was <m>): <what grew>`; it never edits the test. Above 200 KB the controller stops and asks the owner. Task 32 sets the final value.
- Git: Conventional Commits, rebase before PR [C §8.3]; commit messages must NOT contain `Co-Authored-By` or any AI attribution trailer (owner rule)
- Never edit pi-web; pap imports nothing from it [D §1]. Never use port 30141.
- Design changes go through an ADR in `docs/adr/` [decision 33]. M3's ADRs are 0010 (Collapsible), 0011 (`/dev/ui` not shipped) and 0012 (R120 contrast amendment); M2 holds 0006–0009 (agreement 2).
- Implementers run `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/m1-lessons-checklist.md` on their diff and report each item ✅ / n/a. [controller, owner-approved]
- No browser in M3 (owner C1): the host is a headless VPS (no graphics, no Chrome/libatk, no sudo) and M3 adds no Playwright and no container runner. Everything is a unit or integration test (happy-dom, Vite builds, Tailwind compiles). `scripts/ci-config.test.ts` stays unchanged.
- Work only under `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m3` with absolute paths (the session's default directory may be pi-web); never write to pi-web or to the M2 worktree. [brief, checklist]
- Web-side waits: client RPC calls get no deadline of their own because the runtime settles every call when the socket is declared dead (spec C §4.2 keepalive, 15 s). [checklist]

## Plan conventions

- Working directory for every command: the M3 worktree root `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m3`.
- pnpm comes from the corepack shim (R55): prefix commands with `PATH="/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/bin:$PATH"`. If that worktree is gone (owner T5 archives it once both red-teams are done and `pnpm install` ran in feat-m2/m3), recreate the shim in this worktree: `mkdir -p .superpowers/bin && corepack enable --install-directory .superpowers/bin` (git-ignored) and use that path. Commands below write `pnpm` for short.
- TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep their `.ts`/`.tsx` extension.
- Tests never touch `~/.pi/agent` or `~/.pap`. Web tests use happy-dom (`// @vitest-environment happy-dom`) and the helpers of `apps/web/src/testing/dom.ts`; timers are injected or use `vi.useFakeTimers()`; no sleeps (a microtask `drain()` helper that awaits `Promise.resolve()` a fixed number of times is not a sleep); temp dirs are removed in `finally`/`afterEach`.
- Every task ends with: `pnpm format` on its own files, then `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit` green (plus `pnpm test:int` when the task touches the daemon or the build), then the commit shown.
- knip runs in every task: a feature's `index.ts` re-exports only names that some file imports through it at that task; a later task adds its own names (M3-RT-13). A test-only export is fine (knip counts test files as entries).
- New strings: every task that adds visible text adds its en and fr keys to the namespace catalog named in the task (Task 3 sets them up). French keeps sentence case and French typography (a space before `:` and `?`). A key whose French is the same word goes into `IDENTICAL_IN_FR` in the same commit.
- Class lists live only in a `className` attribute, a `cn(...)` call, or an UPPER_CASE constant whose name ends in `CLASSES`, `VARIANTS`, `SIZES`, `TONES`, `STYLE` or `RING` (the class-coverage gate of Task 2 reads exactly those places).
- Every primitive and AI component root carries `data-slot="<name>"` (T3/Orca convention: stable hooks for tests and parent rules, never for restyling).
- Where a task gives test cases as bullets instead of code (UI screens), each bullet is one `it(...)` with exactly the inputs, selectors and expected values it states; the implementer writes them as code and sees them fail before writing the implementation (checklist: tests prove something). Code is given in full for contracts, security-relevant logic and every pure core (tokens, chords, `when`, merge, workspace, separator, ranking, theme derivation, account-document sync, markdown safety).
- **Rulings (pre-dispatch)** under each task are decided; an implementer does not reopen them. An item marked "discovered during implementation" is the only kind left open: the implementer records what it found in the report, and the controller rules then.
- Library APIs not verifiable from this host (no `node_modules` in the worktree when the plan was written) are marked "verify against the pinned `.d.ts`": the implementer reads the installed type declarations first and adapts the call, keeping the behaviour and the tests.
- Fix rounds: a task still failing review after three fix rounds goes to an Opus implementer for rounds 4–5 (owner T1).

## Review Focus

Inputs and conditions the specs imply, that no feature test naturally exercises, and that are most likely to bite a person using pap. Each line names the test that pins it.

1. **Stale or corrupt local state after an upgrade** (a `pap.appearance.boot`, `pap.workspace.v1`, `pap.appearance.device.v1` or `pap.keybindings.v1` written by another version, edited by hand, or `localStorage` throwing in a locked-down browser). Expected: pap boots with defaults, never a blank page or a crash loop, and boot-set variables the app no longer resolves are removed. Pinned by: Task 14 `boot-script.test.ts` "ignores garbage, unknown keys, unknown variables and throwing storage", Task 15 `controller.test.ts` "boot-set variables the app does not resolve are removed on the first apply", Task 18 `persist.test.ts` "drops a workspace of another version or shape", Task 13 `model.test.ts` "device settings parse fail-soft", Task 15 `controller.test.ts` "marks device settings as page-only when storage refuses them", Task 17b `keybindings-store.test.ts` "reads a hand-edited local cache field by field".
2. **Typing with an input method or a non-US layout** (Japanese/Chinese IME in Safari reporting keyCode 229, French AZERTY where Ctrl+Alt is AltGr, Cyrillic with Ctrl). Expected: no shortcut fires during composition, Escape cancels the composition instead of closing a dialog, AltGr characters still type, Ctrl+K still works on a Cyrillic layout, a chord recorded on AZERTY means the same physical key elsewhere. Pinned by: Task 16a `keys.test.ts` (229, isComposing, `Process`, AltGraph, Cyrillic with Ctrl, mac Option+letter, AZERTY digits, AZERTY Ctrl+1 recorded as `mod+1`, a physical `/` never fires on Shift+/), Task 17a `dispatcher.test.ts` (composition), Task 8 `Dialog.test.tsx` "does not close on the Escape that ends a Safari composition", Task 6 `submit-shortcut.test.ts` (229).
3. **Imported JSON and model text from outside** (a theme or keybindings file that is malformed, oversized, or carries `url(...)` / script-looking values; model markdown with raw HTML, `javascript:` links or remote images). Expected: a precise error per entry, nothing half-applied, no value other than a hex colour ever reaches a style property, the server refuses oversize payloads, model text never becomes markup or a request. Pinned by: Task 12 `service.test.ts` "refuses a value over 128 KiB" and `settings.test.ts` "lets only hex colours into a theme", Task 13 `derive.test.ts` "only hex colours reach the token map", Task 14 `boot-script.test.ts` (hostile cache values), Task 26 `theme-io.test.ts`, Task 27 `keybindings-io.test.ts`, Task 10b `render.test.tsx` (raw HTML, `javascript:` links, images).
4. **A shortcut the browser keeps** (Ctrl+W, Ctrl+T, Ctrl+N, Cmd+Q, Ctrl+Tab, Ctrl+1..9, Alt+1..9 off Apple platforms) chosen in the editor. Expected: the editor says the browser may keep it instead of saving a binding that silently never fires; the palette binds no digit chords. Pinned by: Task 16b `resolve.test.ts` "flags browser-reserved chords", Task 27 `ShortcutsEditor.test.tsx` (the recorder refuses `Ctrl+W`) and `keybindings-io.test.ts` (reserved warning).
5. **A link or a restored tab to something that is gone** (a session id that no longer exists, `/settings/unknown`, `/dev/ui` in a production build, a lazy chunk renamed by an update while a tab stayed open). Expected: a not-found screen with a way home, a closable tab, never a redirect loop; a chunk that fails to load leaves the shell standing and offers a reload. Pinned by: Task 18 `item-path.test.ts` and `persist.test.ts`, Task 19a `AppShell.test.tsx` "unknown path shows not found without opening a tab", Task 19a `router.test.tsx` "a render error shows the translated error screen with Reload", Task 21 `lib/lazy.test.tsx` "a chunk that fails to load renders nothing, reports once, and the next attempt loads again", Task 22 `PaletteHost.test.tsx` (a stale palette chunk leaves the shell standing), Task 32 build-output test "ships no gallery in the production build".
6. **Two tabs or two devices editing account settings** (the phone flips a switch during a flaky reconnect while the laptop holds three custom themes; an older document without a field added later). Expected: no change is lost or overwritten by a stale copy; a document missing one field keeps the others; nothing is saved before the first successful load. Pinned by: Task 12 `service.test.ts` "a stale baseRevision is refused and the stored document is unchanged", Task 15 `account-setting.test.ts` (hold until loaded, load-error never saves, conflict → re-read, merge, one retry, one save at a time, re-sync keeps a pending change), Task 13 `model.test.ts` "a document missing one field keeps the others", Task 25 "reset keeps the custom themes".

## Coordination with M2 (parallel worktree)

Ownership is the planning brief's contract. M3 owns `packages/ui/**`, `apps/web/src/styles.css`, `apps/web/index.html`, `apps/web/src/routes/**`, the `apps/web/src/i18n/**` structure, theming and appearance settings, keybindings, Cmd+K, `/dev/ui`, markdown and code highlighting in messages (agreement 9). M2 owns `apps/daemon/**`, `packages/pi-host/**`, `packages/contracts/**`, `apps/web/src/runtime/**`, `apps/web/src/stores/**` and `apps/web/src/features/sessions/**`. The browser e2e work that the brief gave M3 is deferred (owner C1).

Coordination-contract exception, accepted by the owner (R3-8, agreement 13): M3's `settings` daemon module, its contracts file and the `settings` permission domain live inside M2-owned areas; their hunks in shared files are one line each and Opus-reviewed (Task 12). What M3 touches, and why (all listed again in "Merge order and conflict notes"):

| Shared file | M3 change | Size |
|---|---|---|
| `packages/contracts/src/permissions.ts` | add `"settings"` to `DOMAINS` | 1 line |
| `packages/contracts/src/methods.ts` | import `settingsMethods`, spread it first in the catalogue | 2 lines |
| `packages/contracts/src/index.ts` | `export * from "./settings.ts";` | 1 line |
| `packages/contracts/src/methods.test.ts` | add `"settings.set"` to the mutation list | 1 line |
| `apps/daemon/src/daemon.ts` | import the settings module, add its migrations and handlers | 4 lines |
| `apps/web/src/i18n/en.ts`, `fr.ts` | import the M3 namespace catalogs and spread them first; existing keys untouched | 4 lines each |
| `apps/web/src/i18n/i18n.test.ts` | reactive-locale cases, `IDENTICAL_IN_FR` in "translates every key into French" | one test body |
| `apps/web/src/features/sessions/SessionScreen.test.tsx` | the Stop button's class assertions (`bg-panel` → `bg-surface`, `border-error` → `border-err`), Task 5 | 2 lines |
| `budgets.json`, `scripts/check-budgets.ts` (+ test) | provisional and final `initialBundleGzipKb`; `lazyAssets` | 1 line; one function |
| `apps/web/src/main.tsx`, `vite.config.ts`, `src/build-output.int.test.ts`, `src/vite-config.test.ts`, `src/styles.css` | boot script, providers, CSP and lazy-chunk checks, styles | M3 only (M2 touches `build-output.int.test.ts` only through `budgets.json`) |
| `apps/web/src/features/auth/**` | restyle and move "Add a passkey" into Settings | M3 only (not in M2's list) |
| `DESIGN.md` | §3 tokens and §7.4 focus amended for R120 (ADR 0012) | M2 adds its ANSI rule under §9; different sections (agreement 8) |
| `eslint.config.js`, `knip.json`, `package.json`, `pnpm-lock.yaml`, `AGENTS.md` | new rule, ignores, boundary elements, deps, topic note | root files both may touch |

New files only: `packages/contracts/src/settings.ts`, `apps/daemon/src/modules/settings/**`.

**Pipelining with M2.** No M3 task waits for an M2 merge: every task builds on `main` as it is (f765f2a) and renders M2's screens as they exist there. The post-merge tasks P1–P7 wait for both milestones (see "Merge order and conflict notes"). M3 does not rebase on `main` in the middle of the milestone, only before its PR, so M2's merge never forces a mid-milestone rework.

M3 reads M2-owned code only through stable surfaces: `getRuntime()` / `rpc.call` / `useConnectionState` from `apps/web/src/runtime/index.ts`, `sessions.list` from the catalogue, and the screens `SessionListScreen()` and `SessionScreen({ sessionId })` from `apps/web/src/features/sessions/`, which the shell renders inside panes. M3 keeps this `@pap/ui` API of `main` working until P1 (agreement 5): `Button`, `TextField`, `Message`, `ApprovalCard` (M1 props), `cn`, `FOCUS_RING`, `once`, and the M1 utility names `bg-panel`, `border-line`, `text-human*`, `text-on-fill`, `text-attention*`, `text-error`, `text-fg`, `text-muted`… as aliases.

## Pre-execution conflict scan

Tasks run one at a time (subagent-driven). These pairs share files or interfaces; keep the order and re-read the earlier task's result before starting the later one.

| Tasks | Shared file or interface | Rule |
|---|---|---|
| 1a → 1b, 2, 4–11 | `packages/ui/src/tokens.css` + `utilities.css` utility names (`label-hud`, `focus-ring`, `h-control`, `p-s*`, `state-*` variants) | Task 1a is the vocabulary; later tasks use only names its tests pin |
| 1a, 13 | `eslint.config.js` `pap/no-raw-colors` block `ignores` | 1a adds `presets.ts`, 13 adds `contrast.ts` and `derive.ts`; nothing else joins the list |
| 2 → every UI task | class-coverage and compiler gates | a later task that adds a class Tailwind cannot generate fails Task 2's test: fix the class, never the allowlist |
| 3 → every task adding text or a client `catch` | `apps/web/src/i18n/catalog/*.ts`, `apps/web/src/lib/report.ts` | each task appends to its own namespace block; every client catch reports or surfaces |
| 4–11 | `packages/ui/src/index.ts` exports | append-only, alphabetical within each group |
| 5, 6, 7, 8 → 9, 10, 10b | `Button`, `Chip`, `Collapsible`, `Tooltip` APIs | AI components consume the primitive props exactly as produced |
| 1b, 10b, 11, 14, 32 | `apps/web/src/build-output.int.test.ts` | append cases inside the existing `describe`; never loosen an existing expectation except the two Task 11 states |
| 1b, 10b, 23 | `apps/web/src/styles.css` | 1b rewrites it; 10b adds nothing there (its variables live in `utilities.css`); 23 appends the phone rules |
| 12 → 13, 15, 17b, 26, 27 | `packages/contracts/src/settings.ts` (`AccountAppearance`, `KeybindingRules`, `settings.get/set`, `baseRevision`) | schemas are the single source for server validation and client import checks |
| 13 → 14, 15, 25, 26 | `features/appearance/model.ts`, `derive.ts`, `contrast.ts` | pure model first, runtime and UI after |
| 14 → 15 | `apply.ts` (`applyAppearance`, `inlineAppearanceVars`, `writeBootCache`, `BOOT_KEY`, `BOOT_VAR_NAMES`) | the controller only calls the applier |
| 15 → 17b | `lib/account-setting.ts` (`createAccountDocument`) | keybindings reuse the same engine, never a copy |
| 16a → 16b → 17a → 17b, 22, 27 | `features/commands/keys.ts`, `labels.ts`, `when.ts`, `resolve.ts`, `defaults.ts` | core before dispatcher, palette and editor |
| 18 → 19a, 20, 21, 23 | `features/workspace/model.ts`, `workspace-store.ts`, `item-path.ts` | model before shell |
| 19a → 19b → 20–25, 28 | `routes/shell/AppShell.tsx`, `routes/router.tsx`, `routes/shell/pane-renderers.tsx` | one shell task at a time; renderers are replaced in the map, never special-cased |
| 21 → 22, 24, 26 | `apps/web/src/lib/lazy.tsx` (`LazyBoundary`, `useRetryableLazy`, `notifyLazyFailure`) | every lazy chunk mounts through it |
| 24 → 25, 27 | `routes/settings/sections.tsx` (`SETTINGS_SECTION_RENDERERS`) | sections plug into the map Task 24 creates |
| 14, 28 | `apps/web/vite.config.ts` | 14 adds the boot plugin; 28 does not touch it |
| 2, 3, 13, 14, 15, 19a, 28 | `eslint.config.js`, `knip.json` | append entries, never reorder |
| 1a, 4, 5, 10b, 22 | `package.json` / `pnpm-lock.yaml` (`@tailwindcss/node`, `lucide-react`, `radix-ui`, `react-markdown`, `remark-gfm`, `shiki`, `cmdk`) | one `pnpm add -E` per task, lockfile committed with it |

## File Structure

```
packages/ui/
  package.json                     exports ".", "./tokens.css", "./utilities.css", "./fonts.css"; deps radix-ui,
                                   lucide-react, react-markdown, remark-gfm, shiki
  fonts/*.woff2 + *-OFL.txt        Manrope, JetBrains Mono (moved from apps/web/src/fonts)
  src/tokens.css                   themes night/day/hc, densities, global variables, Tailwind @theme mapping (≤ 400 lines)
  src/utilities.css                @custom-variant, @utility, keyframes, motion rules, code-highlight variables
  src/fonts.css                    @font-face, self-hosted
  src/token-names.ts               THEME_TOKENS, THEMES, DENSITIES (single list for tests and the theme editor)
  src/presets.ts                   PRESET_TOKENS (DESIGN §3 values as amended by ADR 0012, checked against tokens.css)
  src/feedback.ts                  feedbackPhase, usePendingFeedback, usePendingAction (DESIGN §7.3)
  src/format.ts                    formatCost, formatDuration, formatDiffCounts (DESIGN §11)
  src/media.ts                     useMediaQuery, useIsPhone (internal)
  src/icons.ts                     Icon + curated lucide re-exports
  src/primitives/                  Button, IconButton, Tooltip, Kbd, TextField, Select, Switch, Checkbox, Slider,
                                   Segmented, Chip, Badge, Avatar, Meter, ProgressBar, Spinner, Banner, EmptyState,
                                   OpenTab, Collapsible, Dialog, Menu, Toast (+ submit-shortcut, composition)
  src/ai/                          Message (+actions, branch), AuthorGroup, DaySeparator, RunStatusChip, Fence,
                                   Reasoning, ToolCard, ApprovalCard, Markdown (+ markdown/{render,CodeBlock,highlight})
  src/brand/                       Mark, Wordmark
apps/web/
  index.html                       title, viewport, SVG favicon; the boot script is injected by the plugin
  vite.config.ts                   + appearanceBoot() plugin
  vite/appearance-boot.ts          Vite plugin: emits the hashed classic boot script
  icons-src/*.svg                  favicon tile, maskable PWA and Apple touch sources (PNG rendering: M12)
  public/favicon.svg
  src/main.tsx                     boot order, providers
  src/styles.css                   tailwind + @pap/ui tokens/utilities/fonts + base
  src/lib/                         report.ts (bounded client issue log), account-setting.ts (settings.get/set,
                                   compare-and-set account documents), lazy.tsx (LazyBoundary, useRetryableLazy)
  src/i18n/                        index.ts (+useT/useLocale), catalog/{shell,settings,commands,gallery}.ts,
                                   server-text.ts
  src/features/appearance/         model, derive, contrast, boot-script.js, apply, controller, appearance-store,
                                   AppearancePanel (+ sections, preview), ThemeEditor, CustomThemes, theme-io
  src/features/commands/           keys, when, defaults, resolve, labels, registry, dispatcher, context,
                                   keybindings-store, use-command, ShortcutsHelp, palette/{rank,CommandPalette},
                                   editor/{ShortcutsEditor,ShortcutRecorder,keybindings-io}
  src/features/workspace/          model, item-path, persist, workspace-store, separator, SplitView
  src/routes/                      router (createAppRouter), RouteError, RootLayout (auth gate)
  src/routes/shell/                AppShell, Rail, TopBar, TabBar, PaneHost, pane-renderers, TreeDrawer, SessionTree,
                                   session-groups, InboxDrawer, MobileShell, BottomNav, TabSwitcher, ConnectionBanner,
                                   NotFound, item-title, navigate, PaletteHost, palette-items, shell-commands,
                                   shell-context, sessions-cache, use-shell-effects, use-viewport-height
  src/routes/settings/             SettingsScreen (lazy), sections, LanguageSection, AccountSection
  src/gallery/                     Gallery, GalleryFrame, sections/*, fixtures (dev-only pane)
  src/compiler-gate.test.ts        React Compiler gate
apps/daemon/src/modules/settings/  index, service, store, rpc, migrations/202610111000_settings.sql
packages/contracts/src/settings.ts AccountAppearanceFields, AccountAppearance, KeybindingRules, settingsMethods
scripts/class-coverage.ts (+test), scripts/literal-coverage.ts (+test), scripts/tailwind-compile.ts,
scripts/notices.test.ts
THIRD_PARTY_NOTICES.md, LICENSES/Apache-2.0.txt   AI Elements (Apache-2.0) notice and the canonical licence text
docs/adr/0010-collapsible-primitive.md, docs/adr/0011-dev-ui-not-shipped.md,
docs/adr/0012-r120-contrast-amendment.md, docs/agents/web.md
```

---
# Phase 1 — Foundations

### Task 1a: DESIGN.md tokens — three themes, three densities, the R120 amendment (ADR 0012)

Replaces the M1 subset with the whole of DESIGN.md §3, §5 and §7 as amended by ADR 0012 (owner M3-Q1, option b). Raw values use DESIGN.md's names (`--bg`, `--surface-2`, `--you-ink`…); Tailwind sees them through `@theme inline`. The M1 utility names stay as aliases until post-merge task P1, because M2's screens use them. `tokens.css` holds the variables and the Tailwind mapping; `utilities.css` holds the variants, utilities, keyframes and motion rules, so neither file passes 400 lines (M3-RT-20). This task changes `packages/ui`, `eslint.config.js`, `DESIGN.md` and the ADR only; Task 1b wires the files into the web app.

**Files:**
- Modify: `packages/ui/src/tokens.css` (rewrite), `packages/ui/src/tokens.test.ts` (rewrite), `packages/ui/src/index.ts`, `packages/ui/package.json` (export `./utilities.css`)
- Create: `packages/ui/src/utilities.css`, `packages/ui/src/token-names.ts`, `packages/ui/src/presets.ts`
- Modify: `eslint.config.js` (`packages/ui/src/presets.ts` in the `pap/no-raw-colors` block's `ignores`, M3-RT-02)
- Modify: `DESIGN.md` (§3.1, §3.2, §3.3, §7.4 only, agreement 8); Create: `docs/adr/0012-r120-contrast-amendment.md`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - CSS custom properties per theme (`:root, [data-theme="night"]`, `[data-theme="day"]`, `[data-theme="hc"]`, no-JS fallback): every name of `THEME_TOKENS` plus `--shadow-overlay`; per density (`[data-density="compact|comfortable|mixed"]`): `--size-ui`, `--size-chat`, `--leading-chat`, `--size-code`, `--space-1..6`, `--control-h`, `--rail-w`, `--bar-h`, `--avatar-size`; global: `--font-ui`, `--font-code`, `--label-transform`, `--motion-fast`, `--motion-base`, `--grid-size`, `--chat-max-width`.
  - Attributes on `<html>` read by CSS: `data-theme`, `data-density`, `data-font-ui="system"`, `data-font-mono="system"`, `data-labels="sentence"`, `data-grid="off"`, `data-rail="right"`, `data-motion="system|reduced|none"`, `data-chat-width="wide|narrow"`, `data-keyboard-open`.
  - Utilities (compiled once Task 1b imports the files): colours `bg-|text-|border-|fill-|outline-` × `bg, bg-side, surface, surface-2, border, border-strong, control-border, fg, muted, dim, agent, agent-fill, agent-ink, you, you-fill, you-ink, you-tint, you-line, you-text, attn, attn-fill, attn-ink, attn-tint, attn-line, attn-title, ok, err, diff-add, diff-del, focus` (+ M1 aliases `panel, line, human, human-fill, human-tint, human-line, human-text, on-fill, attention, attention-tint, attention-line, error`); text sizes `text-label, text-ui, text-chat, text-code, text-h2, text-h1, text-display`; `tracking-label`, `tracking-display`; radii `rounded-sm` (2 px), `rounded-md` (3 px); spacing `p-s1..s6` (any spacing utility), `h-control`, `h-bar`, `w-rail`, `size-avatar`, `w-drawer-tree`, `w-drawer-inbox`, `min-w-pane`, `w-status-panel`; custom `label-hud`, `focus-ring`, `shadow-overlay`, `bg-grid`, `h-app`, `max-h-app`, `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe`, `duration-fast`, `duration-base`, `animate-indeterminate`, `animate-overlay-in`, `max-w-chat`; class `theme-swap` (plain CSS).
  - Variants: `can-hover:`, `rail-right:`, `state-open:`, `state-closed:`, `state-checked:`, `state-on:`, `state-active:`.
  - `packages/ui/src/token-names.ts`: `THEME_TOKENS` (31 names), `type ThemeToken`, `THEMES = ["night","day","hc"]`, `type ThemeName`, `DENSITIES = ["compact","comfortable","mixed"]`, `type Density`.
  - `packages/ui/src/presets.ts`: `PRESET_TOKENS: Readonly<Record<ThemeName, Readonly<Record<ThemeToken, string>>>>`.
  - `@pap/ui/utilities.css` export; ADR 0012.

**Rulings (pre-dispatch):**
- R120 is option (b) (owner M3-Q1): ADR 0012 and the DESIGN.md amendment (§3 and §7.4 only) ship in this task, and `tokens.test.ts` asserts every amended value and its contrast ratio. [M3R1]
- `focus-ring`, `control-border` and `attn-title` become theme tokens with concrete values per preset (night `#fb923c` / `#6b6485` / `#f472b6`, day `#ea580c` / `#8f877a` / `#be185d`, high contrast `#fb923c` / `#8a8a8a` / `#f9a8d4`), and `--attn-ink` is `#110f18` in night and high contrast. High contrast keeps its border-strong `#8a8a8a` as control border (6.1:1 on its bg): an implementation of the ADR, not a further change. Inputs and controls draw `border-control-border`; the hairline `border` stays decorative. [M3R2]
- The high-contrast values DESIGN §3.3 leaves out (inks, tints, lines, `--you-text`, diff tones) are derived by §13.2's rules (fills = night): an implementation of §13.2, no ADR. [M3R3]
- Comfortable density lists five spacing steps; `--space-6` repeats 32 px. Accepted. [M3R4]
- `pap/no-raw-colors` ignores `packages/ui/src/presets.ts` (colour data, pinned to `tokens.css` by `tokens.test.ts`); nothing else in `packages/ui` joins the list. [M3R5]
- `tokens.css` keeps `@theme inline` although DESIGN §14 writes `@theme static`: a utility must read `var(--bg)` where it is used so `data-theme` on a subtree (gallery frames, `Mark mode`) re-themes it; the reason is written in the file and in `docs/agents/web.md` (M3-RT-37). [M3R6]

- [ ] **Step 1: Write the token name list and the presets**

`packages/ui/src/token-names.ts`:

```ts
/** DESIGN.md §3 (with ADR 0012): the custom properties every theme defines. The theme editor, the presets and the tests read this list. */
export const THEME_TOKENS = [
  "bg",
  "bg-side",
  "surface",
  "surface-2",
  "border",
  "border-strong",
  "control-border",
  "text",
  "text-muted",
  "text-dim",
  "grid",
  "focus-ring",
  "agent",
  "agent-fill",
  "agent-ink",
  "you",
  "you-fill",
  "you-ink",
  "you-tint",
  "you-line",
  "you-text",
  "attn",
  "attn-fill",
  "attn-ink",
  "attn-tint",
  "attn-line",
  "attn-title",
  "ok",
  "err",
  "diff-add",
  "diff-del",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export const THEMES = ["night", "day", "hc"] as const;
export type ThemeName = (typeof THEMES)[number];

export const DENSITIES = ["compact", "comfortable", "mixed"] as const;
export type Density = (typeof DENSITIES)[number];
```

`packages/ui/src/presets.ts` (values from DESIGN.md §3.1–3.3 as amended by ADR 0012; the values §3.3 leaves out follow §13.2: inks, tints and lines come from the fills, which high contrast keeps from night; diff tones are the high-contrast ok/err at 8 % alpha):

```ts
import type { ThemeName, ThemeToken } from "./token-names.ts";

type Tokens = Readonly<Record<ThemeToken, string>>;

const night: Tokens = {
  bg: "#110f18",
  "bg-side": "#14111d",
  surface: "#1a1724",
  "surface-2": "#241f33",
  border: "#2d2840",
  "border-strong": "#3d3657",
  "control-border": "#6b6485",
  text: "#f2effa",
  "text-muted": "#9c95b5",
  "text-dim": "#6b6485",
  grid: "#ffffff06",
  "focus-ring": "#fb923c",
  agent: "#a78bfa",
  "agent-fill": "#a78bfa",
  "agent-ink": "#110f18",
  you: "#fb923c",
  "you-fill": "#fb923c",
  "you-ink": "#1b0d00",
  "you-tint": "#fb923c1a",
  "you-line": "#fb923c66",
  "you-text": "#fed7aa",
  attn: "#ec4899",
  "attn-fill": "#ec4899",
  "attn-ink": "#110f18",
  "attn-tint": "#ec48991a",
  "attn-line": "#ec48998c",
  "attn-title": "#f472b6",
  ok: "#34d399",
  err: "#f87171",
  "diff-add": "#34d39914",
  "diff-del": "#f8717114",
};

const day: Tokens = {
  bg: "#faf9f6",
  "bg-side": "#f3f1ec",
  surface: "#ffffff",
  "surface-2": "#eeebe4",
  border: "#e2ded5",
  "border-strong": "#cfc9bc",
  "control-border": "#8f877a",
  text: "#1c1917",
  "text-muted": "#6b645a",
  "text-dim": "#a8a196",
  grid: "#1c19170a",
  "focus-ring": "#ea580c",
  agent: "#6d28d9",
  "agent-fill": "#7c3aed",
  "agent-ink": "#ffffff",
  you: "#c2410c",
  "you-fill": "#fb923c",
  "you-ink": "#1b0d00",
  "you-tint": "#fff4ea",
  "you-line": "#fdba74",
  "you-text": "#431407",
  attn: "#be185d",
  "attn-fill": "#db2777",
  "attn-ink": "#ffffff",
  "attn-tint": "#fdf1f6",
  "attn-line": "#f9a8d4",
  "attn-title": "#be185d",
  ok: "#047857",
  err: "#dc2626",
  "diff-add": "#04785714",
  "diff-del": "#dc262614",
};

const hc: Tokens = {
  ...night,
  bg: "#000000",
  "bg-side": "#0a0a0a",
  surface: "#111111",
  "surface-2": "#1f1f1f",
  border: "#5a5a5a",
  "border-strong": "#8a8a8a",
  "control-border": "#8a8a8a",
  text: "#ffffff",
  "text-muted": "#d0d0d0",
  "text-dim": "#a0a0a0",
  grid: "transparent",
  agent: "#c4b5fd",
  you: "#fdba74",
  attn: "#f9a8d4",
  "attn-title": "#f9a8d4",
  ok: "#6ee7b7",
  err: "#fca5a5",
  "diff-add": "#6ee7b714",
  "diff-del": "#fca5a514",
};

/** DESIGN.md §3.1–3.3 with ADR 0012, lower case. `tokens.test.ts` proves tokens.css says exactly the same. */
export const PRESET_TOKENS: Readonly<Record<ThemeName, Tokens>> = { night, day, hc };
```

In `eslint.config.js`, in the block that enables `pap/no-raw-colors`, change `ignores` to:

```js
    // Colour data and colour math, each pinned by its tests (M3-RT-02). Nothing else may hold a raw colour.
    ignores: ["**/*.test.ts", "**/*.test.tsx", "packages/ui/src/tokens.css", "packages/ui/src/presets.ts"],
```

- [ ] **Step 2: Write the failing token tests**

`packages/ui/src/tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESET_TOKENS } from "./presets.ts";
import { THEME_TOKENS, THEMES, type ThemeName } from "./token-names.ts";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const utilities = readFileSync(new URL("./utilities.css", import.meta.url), "utf8");

interface Block {
  readonly media: string | null;
  readonly selector: string;
  readonly decls: ReadonlyMap<string, string>;
  readonly body: string;
}

/** Top-level rules and the rules of @media blocks, comments removed. Enough for a hand-written token file. */
function parse(source: string): Block[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  const walk = (src: string, media: string | null): void => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open === -1) return;
      const raw = src.slice(i, open);
      const prelude = raw.slice(raw.lastIndexOf(";") + 1).trim().replace(/\s+/g, " ");
      let depth = 1;
      let j = open + 1;
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
      }
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) walk(body, prelude);
      else {
        const decls = new Map<string, string>();
        for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) decls.set(m[1] ?? "", (m[2] ?? "").trim().toLowerCase());
        out.push({ media, selector: prelude, decls, body });
      }
      i = j;
    }
  };
  walk(text, null);
  return out;
}

// WCAG 2.x contrast, with a translucent colour composited over its backdrop (the token tests' own copy; the app's
// contrast.ts arrives in Task 13).
const channels = (hex: string): number[] => [1, 3, 5, 7].filter((i) => i < hex.length).map((i) => parseInt(hex.slice(i, i + 2), 16));
function over(color: string, backdrop: string): string {
  const [r = 0, g = 0, b = 0, a = 255] = channels(color);
  const [br = 0, bg = 0, bb = 0] = channels(backdrop);
  const mix = (c: number, d: number) => Math.round(c * (a / 255) + d * (1 - a / 255));
  return `#${[mix(r, br), mix(g, bg), mix(b, bb)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const blocks = parse(css);
const themeBlocks = blocks.filter((block) => block.decls.has("--bg"));
const PER_THEME = [...THEME_TOKENS.map((name) => `--${name}`), "--shadow-overlay"];

describe("theme tokens (DESIGN.md §3)", () => {
  it("sets theme values only from equal-specificity selectors, plus a no-JS fallback (R120)", () => {
    expect(themeBlocks.map((block) => `${block.media ?? ""}|${block.selector}`)).toEqual([
      '|:root, [data-theme="night"]',
      '|[data-theme="day"]',
      '|[data-theme="hc"]',
      '@media (prefers-color-scheme: light)|:root:not([data-theme])',
    ]);
    for (const block of themeBlocks) expect(block.body).not.toContain("!important");
  });

  it("defines every token in every theme", () => {
    for (const block of themeBlocks) for (const name of PER_THEME) expect(block.decls.has(name), `${block.selector} ${name}`).toBe(true);
  });

  it("matches the presets, and the fallback is the day theme", () => {
    const [night, day, hc, fallback] = themeBlocks;
    for (const name of THEME_TOKENS) {
      expect(night?.decls.get(`--${name}`), name).toBe(PRESET_TOKENS.night[name]);
      expect(day?.decls.get(`--${name}`), name).toBe(PRESET_TOKENS.day[name]);
      expect(hc?.decls.get(`--${name}`), name).toBe(PRESET_TOKENS.hc[name]);
      expect(fallback?.decls.get(`--${name}`), name).toBe(PRESET_TOKENS.day[name]);
    }
  });

  it("keeps the decision 11 role colours", () => {
    for (const hex of ["#110f18", "#a78bfa", "#fb923c", "#ec4899", "#faf9f6", "#6d28d9", "#c2410c", "#be185d"]) {
      expect(css.toLowerCase()).toContain(hex);
    }
  });

  it("applies ADR 0012's values (R120)", () => {
    const pick = (token: "focus-ring" | "control-border" | "attn-title" | "attn-ink") => THEMES.map((theme) => PRESET_TOKENS[theme][token]);
    expect(pick("focus-ring")).toEqual(["#fb923c", "#ea580c", "#fb923c"]);
    expect(pick("control-border")).toEqual(["#6b6485", "#8f877a", "#8a8a8a"]);
    expect(pick("attn-title")).toEqual(["#f472b6", "#be185d", "#f9a8d4"]);
    expect(pick("attn-ink")).toEqual(["#110f18", "#ffffff", "#110f18"]);
    expect(PRESET_TOKENS.night.border).toBe("#2d2840"); // the hairline stays decorative
  });

  it.each(THEMES)("reaches the ratios ADR 0012 promises in %s", (theme: ThemeName) => {
    const t = PRESET_TOKENS[theme];
    for (const ground of [t.bg, t.surface]) {
      expect(ratio(t["focus-ring"], ground), `focus ring on ${ground}`).toBeGreaterThanOrEqual(3);
      expect(ratio(t["control-border"], ground), `control border on ${ground}`).toBeGreaterThanOrEqual(3);
    }
    expect(ratio(t["attn-title"], over(t["attn-tint"], t.surface)), "approval title on its card").toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["attn-ink"], t["attn-fill"]), "ink on the attention fill").toBeGreaterThanOrEqual(4.5);
  });

  it("measures what ADR 0012 records, so its numbers stay true", () => {
    expect(ratio("#ea580c", "#faf9f6")).toBeCloseTo(3.38, 2);
    expect(ratio("#8f877a", "#faf9f6")).toBeCloseTo(3.37, 2);
    expect(ratio("#6b6485", "#1a1724")).toBeCloseTo(3.18, 2);
    expect(ratio("#f472b6", over("#ec48991a", "#1a1724"))).toBeCloseTo(5.96, 2);
    expect(ratio("#110f18", "#ec4899")).toBeCloseTo(5.39, 2);
    expect(ratio("#fb923c", "#faf9f6")).toBeCloseTo(2.15, 2); // why the day ring changed
  });

  it("gives each role its own ink", () => {
    expect(PRESET_TOKENS.night["agent-ink"]).toBe("#110f18");
    expect(PRESET_TOKENS.day["agent-ink"]).toBe("#ffffff");
    expect(PRESET_TOKENS.night["you-ink"]).toBe("#1b0d00");
  });

  it("keeps the M1 utility names as aliases until post-merge task P1", () => {
    for (const alias of [
      "--color-panel: var(--surface);",
      "--color-line: var(--border);",
      "--color-human: var(--you);",
      "--color-human-fill: var(--you-fill);",
      "--color-on-fill: var(--you-ink);",
      "--color-attention: var(--attn);",
      "--color-error: var(--err);",
      "--color-fg: var(--text);",
      "--color-muted: var(--text-muted);",
    ]) {
      expect(css).toContain(alias);
    }
  });

  it("resets the default Tailwind palette before the first colour", () => {
    const reset = css.indexOf("--color-*: initial;");
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(css.indexOf("--color-bg:"));
  });

  it("turns the grid off after the themes, so it wins over them", () => {
    const off = blocks.findIndex((block) => block.selector === '[data-grid="off"]');
    expect(off).toBeGreaterThan(blocks.indexOf(themeBlocks[2] as Block));
  });

  it("keeps both files within the 400-line rule (AGENTS.md)", () => {
    expect(css.split("\n").length).toBeLessThanOrEqual(400);
    expect(utilities.split("\n").length).toBeLessThanOrEqual(400);
  });
});

describe("densities (DESIGN.md §5)", () => {
  const density = (selector: string) => blocks.find((block) => block.selector === selector)?.decls;

  it("sizes compact, comfortable and mixed as the table says", () => {
    const compact = density(':root, [data-density="compact"]');
    const comfortable = density('[data-density="comfortable"]');
    const mixed = density('[data-density="mixed"]');
    expect([compact?.get("--size-ui"), compact?.get("--size-chat"), compact?.get("--leading-chat"), compact?.get("--size-code")]).toEqual(["13px", "14px", "1.55", "12px"]);
    expect([comfortable?.get("--size-ui"), comfortable?.get("--size-chat"), comfortable?.get("--leading-chat"), comfortable?.get("--size-code")]).toEqual(["14px", "15px", "1.65", "12.5px"]);
    expect([mixed?.get("--size-ui"), mixed?.get("--size-chat"), mixed?.get("--leading-chat")]).toEqual(["13px", "15px", "1.65"]);
    expect([compact?.get("--control-h"), compact?.get("--rail-w"), compact?.get("--bar-h"), compact?.get("--avatar-size")]).toEqual(["26px", "48px", "34px", "28px"]);
    expect([comfortable?.get("--control-h"), comfortable?.get("--rail-w"), comfortable?.get("--bar-h"), comfortable?.get("--avatar-size")]).toEqual(["32px", "56px", "40px", "32px"]);
    expect([1, 2, 3, 4, 5, 6].map((n) => compact?.get(`--space-${n}`))).toEqual(["4px", "8px", "12px", "16px", "24px", "32px"]);
    expect([1, 2, 3, 4, 5].map((n) => comfortable?.get(`--space-${n}`))).toEqual(["6px", "10px", "16px", "24px", "32px"]);
  });
});

describe("motion, labels and fonts", () => {
  it("drops transitions to 0 ms for reduced and none, and for system under prefers-reduced-motion", () => {
    expect(blocks.find((b) => b.selector === '[data-motion="reduced"], [data-motion="none"]')?.decls.get("--motion-base")).toBe("0ms");
    const system = blocks.find((b) => b.media === "@media (prefers-reduced-motion: reduce)" && b.selector.includes('[data-motion="system"]'));
    expect(system?.decls.get("--motion-fast")).toBe("0ms");
  });

  it("stops the indeterminate bar under reduced motion", () => {
    expect(utilities).toContain('[data-motion="none"] .animate-indeterminate');
    expect(utilities).toContain('[data-motion="system"] .animate-indeterminate');
  });

  it("switches HUD labels to sentence case with one attribute", () => {
    expect(blocks.find((b) => b.selector === '[data-labels="sentence"]')?.decls.get("--label-transform")).toBe("none");
  });

  it("loads nothing from the network", () => {
    for (const source of [css, utilities]) expect(source).not.toMatch(/url\(|@import|https?:\/\//);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/tokens.test.ts`
Expected: FAIL (`presets.ts` values differ from the M1 file, `utilities.css` missing).

- [ ] **Step 4: Write `tokens.css` and `utilities.css`**

`packages/ui/src/tokens.css`:

```css
/* Night Control tokens: DESIGN.md §3 (themes), §5 (densities), §7.2 (motion), §7.4 (focus); spec B, validated
   (decision 33), contrast amended by ADR 0012 (R120). Raw values carry the DESIGN.md names. Every theme selector
   has the same specificity (R120): the boot script always sets data-theme, the no-JS fallback only applies while
   the attribute is absent. The default Tailwind palette is reset: only the colours below compile (transparent and
   current stay built in). Variants, utilities and keyframes live in utilities.css. Nothing here loads from the
   network.

   `@theme inline`, not `@theme static` as DESIGN §14 writes: a utility must read var(--bg) where it is used, so a
   data-theme on a subtree (gallery frames, Mark's mode) re-themes it. A non-inline theme would resolve
   --color-bg: var(--bg) once on :root. Do not "fix" it. */

@theme inline {
  --color-*: initial;
  --color-bg: var(--bg);
  --color-bg-side: var(--bg-side);
  --color-surface: var(--surface);
  --color-surface-2: var(--surface-2);
  --color-border: var(--border);
  --color-border-strong: var(--border-strong);
  --color-control-border: var(--control-border);
  --color-fg: var(--text);
  --color-muted: var(--text-muted);
  --color-dim: var(--text-dim);
  --color-agent: var(--agent);
  --color-agent-fill: var(--agent-fill);
  --color-agent-ink: var(--agent-ink);
  --color-you: var(--you);
  --color-you-fill: var(--you-fill);
  --color-you-ink: var(--you-ink);
  --color-you-tint: var(--you-tint);
  --color-you-line: var(--you-line);
  --color-you-text: var(--you-text);
  --color-attn: var(--attn);
  --color-attn-fill: var(--attn-fill);
  --color-attn-ink: var(--attn-ink);
  --color-attn-tint: var(--attn-tint);
  --color-attn-line: var(--attn-line);
  --color-attn-title: var(--attn-title);
  --color-ok: var(--ok);
  --color-err: var(--err);
  --color-diff-add: var(--diff-add);
  --color-diff-del: var(--diff-del);
  --color-focus: var(--focus-ring);
  /* M1 names, kept until M2 and M3 have both merged (post-merge task P1 removes them). */
  --color-panel: var(--surface);
  --color-line: var(--border);
  --color-human: var(--you);
  --color-human-fill: var(--you-fill);
  --color-human-tint: var(--you-tint);
  --color-human-line: var(--you-line);
  --color-human-text: var(--you-text);
  --color-on-fill: var(--you-ink);
  --color-attention: var(--attn);
  --color-attention-tint: var(--attn-tint);
  --color-attention-line: var(--attn-line);
  --color-error: var(--err);

  --font-sans: var(--font-ui);
  --font-mono: var(--font-code);
  --text-label: 0.65625rem;
  --text-ui: var(--size-ui);
  --text-chat: var(--size-chat);
  --text-chat--line-height: var(--leading-chat);
  --text-code: var(--size-code);
  --text-h2: 1rem;
  --text-h2--line-height: 1.4;
  --text-h2--font-weight: 700;
  --text-h1: 1.25rem;
  --text-h1--line-height: 1.3;
  --text-h1--font-weight: 800;
  --text-display: 1.75rem;
  --text-display--line-height: 1.15;
  --text-display--font-weight: 800;
  --text-display--letter-spacing: -0.02em;
  --tracking-label: 0.12em;
  --tracking-display: -0.02em;
  --radius-sm: 2px;
  --radius-md: 3px;
  --spacing-s1: var(--space-1);
  --spacing-s2: var(--space-2);
  --spacing-s3: var(--space-3);
  --spacing-s4: var(--space-4);
  --spacing-s5: var(--space-5);
  --spacing-s6: var(--space-6);
  --spacing-control: var(--control-h);
  --spacing-bar: var(--bar-h);
  --spacing-rail: var(--rail-w);
  --spacing-avatar: var(--avatar-size);
  --spacing-drawer-tree: 18.75rem;
  --spacing-drawer-inbox: 22.5rem;
  --spacing-pane: 20rem;
  --spacing-status-panel: 20.625rem;
}
```

then the four theme blocks, in this order and with these selectors: `:root,\n[data-theme="night"]` (`color-scheme: dark`), `[data-theme="day"]` (`color-scheme: light`), `[data-theme="hc"]` (`color-scheme: dark`, preceded by the comment `/* DESIGN.md §3.3; what §3.3 leaves out follows §13.2 (inks, tints and lines from the night fills it keeps). */`), and `@media (prefers-color-scheme: light) { :root:not([data-theme]) { … } }` (`color-scheme: light`, preceded by `/* No JavaScript yet (or ever): follow the system. Applies only while <html> has no data-theme. */`). Each block declares, one per line in `THEME_TOKENS` order, `--<token>: <PRESET_TOKENS[theme][token]>;` (the fallback uses the day values), then `--shadow-overlay`: night and high contrast `0 20px 60px rgba(0, 0, 0, 0.6)`, day and the fallback `0 12px 40px rgba(28, 25, 23, 0.18)`. For example the night block starts:

```css
:root,
[data-theme="night"] {
  color-scheme: dark;
  --bg: #110f18;
  --bg-side: #14111d;
  --surface: #1a1724;
  --surface-2: #241f33;
  --border: #2d2840;
  --border-strong: #3d3657;
  --control-border: #6b6485;
  --text: #f2effa;
```

and ends:

```css
  --diff-add: #34d39914;
  --diff-del: #f8717114;
  --shadow-overlay: 0 20px 60px rgba(0, 0, 0, 0.6);
}
```

After the themes, unchanged from the M1-to-M3 design:

```css
:root,
[data-density="compact"] {
  --size-ui: 13px;
  --size-chat: 14px;
  --leading-chat: 1.55;
  --size-code: 12px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --control-h: 26px;
  --rail-w: 48px;
  --bar-h: 34px;
  --avatar-size: 28px;
}

[data-density="comfortable"] {
  --size-ui: 14px;
  --size-chat: 15px;
  --leading-chat: 1.65;
  --size-code: 12.5px;
  --space-1: 6px;
  --space-2: 10px;
  --space-3: 16px;
  --space-4: 24px;
  --space-5: 32px;
  --space-6: 32px;
  --control-h: 32px;
  --rail-w: 56px;
  --bar-h: 40px;
  --avatar-size: 32px;
}

/* Compact UI with comfortable chat prose (DESIGN.md §5). */
[data-density="mixed"] {
  --size-ui: 13px;
  --size-chat: 15px;
  --leading-chat: 1.65;
  --size-code: 12px;
}

:root {
  --font-ui: "Manrope", ui-sans-serif, system-ui, sans-serif;
  --font-code: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --label-transform: uppercase;
  --motion-fast: 120ms;
  --motion-base: 200ms;
  --grid-size: 24px;
  --chat-max-width: none;
}

[data-font-ui="system"] {
  --font-ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

[data-font-mono="system"] {
  --font-code: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

[data-labels="sentence"] {
  --label-transform: none;
}

[data-chat-width="wide"] {
  --chat-max-width: 64rem;
}

[data-chat-width="narrow"] {
  --chat-max-width: 48rem;
}

[data-motion="reduced"],
[data-motion="none"] {
  --motion-fast: 0ms;
  --motion-base: 0ms;
}

@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion]),
  [data-motion="system"] {
    --motion-fast: 0ms;
    --motion-base: 0ms;
  }
}

@media (max-width: 767.98px) {
  :root {
    --grid-size: 16px;
  }
}

/* After the themes: same specificity, so the later rule wins. */
[data-grid="off"] {
  --grid: transparent;
}
```

`packages/ui/src/utilities.css`:

```css
/* Night Control variants, utilities, keyframes and motion rules (DESIGN.md §4, §7). The variables they read are in
   tokens.css; apps/web/src/styles.css imports both. */

@custom-variant can-hover (@media (hover: hover));
@custom-variant rail-right (&:where([data-rail="right"], [data-rail="right"] *));
@custom-variant state-open (&[data-state="open"]);
@custom-variant state-closed (&[data-state="closed"]);
@custom-variant state-checked (&[data-state="checked"]);
@custom-variant state-on (&[data-state="on"]);
@custom-variant state-active (&[data-state="active"]);

[data-motion="reduced"] .animate-indeterminate,
[data-motion="none"] .animate-indeterminate {
  animation: none;
}

@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion]) .animate-indeterminate,
  [data-motion="system"] .animate-indeterminate {
    animation: none;
  }
}

/* Orca theme swap (src/renderer/src/lib/document-theme.ts): no staggered fades while the theme changes. */
.theme-swap,
.theme-swap *,
.theme-swap *::before,
.theme-swap *::after {
  transition: none !important;
}

html[data-keyboard-open] .pb-safe {
  padding-bottom: 0;
}
```

followed by the two `@keyframes` (`pap-indeterminate`: `translateX(-100%)` → `translateX(300%)`; `pap-overlay-in`: `opacity: 0; transform: translateY(4px)` → `opacity: 1; transform: none`) and these utilities, each preceded by its one-line comment:

```css
/* DESIGN.md §4 HUD label: mono 10.5 px, 600, 0.12em, upper case unless the owner turned it off. */
@utility label-hud {
  font-family: var(--font-code);
  font-size: 0.65625rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: var(--label-transform);
}

/* DESIGN.md §7.4 as amended by ADR 0012: the --focus-ring token. Never removed. */
@utility focus-ring {
  &:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
}

/* Only drawers, the palette, dialogs and toasts (DESIGN.md §3.4). */
@utility shadow-overlay {
  box-shadow: var(--shadow-overlay);
}

/* The faint background grid (DESIGN.md §1): two 1 px line patterns, not a visual gradient. */
@utility bg-grid {
  background-color: var(--bg);
  background-image:
    linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: var(--grid-size) var(--grid-size);
}

/* pw: hooks/useViewportHeight.ts keeps --app-viewport-height at the visual viewport while a keyboard is open. */
@utility h-app {
  height: var(--app-viewport-height, 100dvh);
}

@utility max-h-app {
  max-height: var(--app-viewport-height, 100dvh);
}
```

then `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe` (`padding-<side>: env(safe-area-inset-<side>, 0px)`), `duration-fast` / `duration-base` (`transition-duration: var(--motion-fast|base)`), `animate-indeterminate` (`animation: pap-indeterminate 1.4s linear infinite`, comment "The one continuous animation DESIGN.md §7.2 allows: the running tool card's bar. Static under reduced motion."), `animate-overlay-in` (`animation: pap-overlay-in var(--motion-base) ease-out`), `max-w-chat` (`max-width: var(--chat-max-width)`). (Tailwind compiles the `&:focus-visible` inside `@utility` to a flat selector; Task 1b's nesting check of the built CSS pins it.)

`packages/ui/package.json` `exports`: add `"./utilities.css": "./src/utilities.css"`.

`packages/ui/src/index.ts`: append

```ts
export { PRESET_TOKENS } from "./presets.ts";
export { DENSITIES, THEME_TOKENS, THEMES, type Density, type ThemeName, type ThemeToken } from "./token-names.ts";
```

- [ ] **Step 5: Amend DESIGN.md and write ADR 0012**

`DESIGN.md` (sections §3 and §7.4 only; M2 edits §9, agreement 8):
- §3.1 table: the `--attn` / `--attn-fill` / `--attn-ink` row becomes `` `#EC4899` / `#EC4899` / `#110F18` ``; add three rows after the `--border-strong` row and the `--attn-tint` row respectively: `` | `--control-border` | `#6B6485` | input and control borders (≥ 3:1, ADR 0012); `--border` stays a decorative hairline | ``, `` | `--focus-ring` | `#FB923C` (the you fill) | keyboard focus outline (§7.4) | ``, `` | `--attn-title` | `#F472B6` | approval card titles on the attention tint | ``; change `--border-strong`'s use to "card borders".
- §3.2 table: add `` | `--control-border` / `--focus-ring` / `--attn-title` | `#8F877A` / `#EA580C` / `#BE185D` | ``.
- §3.3 table: add `` | `--control-border` / `--focus-ring` / `--attn-title` / `--attn-ink` | `#8A8A8A` / `#FB923C` / `#F9A8D4` / `#110F18` | ``.
- §7.4: "A 2 px solid `--focus-ring` outline with a 2 px offset on `:focus-visible`: the you fill in night and high contrast, `#EA580C` in day, where the fill reaches only 2.15:1 (ADR 0012). It is never removed."

`docs/adr/0012-r120-contrast-amendment.md`:

```markdown
# ADR 0012 — contrast amendments to DESIGN.md (R120)

Status: accepted · Date: 2026-10-11 · Spec: DESIGN.md §3, §7.4 (decision 33) · Rulings: R54, R120 · Owner decision: M3-Q1, option (b)

DESIGN.md was validated by the owner. Measuring it against WCAG 2.x (1.4.11 non-text contrast ≥ 3:1, 1.4.3 text ≥ 4.5:1)
found five places below the bar. The owner chose to amend DESIGN.md through this ADR.

## Context

- Day focus ring: the you fill `#FB923C` is 2.15:1 on the day background (2.26:1 on white), and R54 asks for it in both modes.
- Control borders: day `--border-strong` `#CFC9BC` is 1.57:1 on bg, night `#3D3657` 1.69:1; input and control borders identify
  the component under 1.4.11.
- Night approval title: `#EC4899` on the attention tint over a surface card is 4.48:1.
- Attention ink: `#FFFFFF` on `#EC4899` (night, high contrast) is 3.53:1, and badge counts are small text.

## Decision

- `--focus-ring` is a theme token: the you fill in night and high contrast, `#EA580C` in day (3.38:1 on bg, 3.56:1 on white).
- `--control-border` is a theme token for inputs and controls: day `#8F877A` (3.37:1 / 3.55:1), night `#6B6485` (3.43:1 /
  3.18:1), high contrast `#8A8A8A`. The hairline `--border` stays decorative.
- `--attn-title` colours approval titles: night `#F472B6` (5.96:1 on its card), day and high contrast their `--attn`.
- `--attn-ink` is `#110F18` on pink fills in night and high contrast (5.39:1); day keeps `#FFFFFF` (4.6:1 on `#DB2777`).

## Consequences

The three new names are theme tokens: presets, custom-theme derivation (DESIGN §13.2, Task 13) and the boot cache carry them.
`packages/ui/src/tokens.test.ts` asserts every value and its ratio, and the ratios this ADR quotes. DESIGN.md §3 and §7.4 carry
the new values.
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test:unit packages/ui && pnpm lint`
Expected: PASS (`pnpm lint` passes with `presets.ts` holding hex strings because of the new `ignores` entry; remove it once to see `pap/no-raw-colors` report it, then restore).

- [ ] **Step 7: Commit**

```bash
pnpm format
git add packages/ui eslint.config.js DESIGN.md docs/adr/0012-r120-contrast-amendment.md
git commit -m "feat(ui): DESIGN.md tokens in three themes and densities, with the ADR 0012 contrast amendment"
```

---

### Task 1b: Fonts in `packages/ui`, the web stylesheet, the Tailwind compile helper and the token-class tests

**Files:**
- Modify: `packages/ui/src/focus.ts`, `packages/ui/package.json` (export `./fonts.css`), `packages/ui/src/primitives/Button.test.tsx`, `packages/ui/src/primitives/TextField.test.tsx` (focus-ring expectations only), `packages/ui/src/tokens.test.ts` (font files)
- Create: `packages/ui/src/fonts.css`
- Move: `apps/web/src/fonts/*` → `packages/ui/fonts/` (`git mv`), delete `apps/web/src/fonts.css`
- Modify: `apps/web/src/styles.css`, `apps/web/src/build-output.int.test.ts` (no native nesting)
- Create: `scripts/tailwind-compile.ts`, `scripts/token-classes.test.ts`
- Modify: root `package.json`, `pnpm-lock.yaml` (`@tailwindcss/node` pinned to the `tailwindcss` version, 4.3.3)

**Interfaces:**
- Consumes: Task 1a.
- Produces:
  - `FOCUS_RING = "focus-ring"` (same export, new value).
  - `@pap/ui/fonts.css` export.
  - `scripts/tailwind-compile.ts`: `compileStyles(): Promise<(candidates: readonly string[]) => string>`, `escapeClass(name: string): string`, `classRule(className: string): RegExp`, `ruleOf(css: string, className: string): string`.

**Rulings (pre-dispatch):**
- Tailwind 4.3.3 is expected to resolve named `--spacing-*` keys (`p-s3`, `w-drawer-tree`). If the compile test shows it does not, the fallback is one `@utility` per spacing class the later tasks name in their Interfaces, appended to `utilities.css`; the test list stays as is. Whether the fallback is needed can only be discovered during implementation. [M3R7]
- Safari 16.4 CSP for the WebSocket (R118) is not checked in M3 (no browser, owner C1); the existing `ws: true` and fonts-as-files tests stay green through the font move. [M3R8]

- [ ] **Step 1: Pin `@tailwindcss/node` and move the fonts**

Run:
```bash
pnpm add -Dw -E @tailwindcss/node@4.3.3
git mv apps/web/src/fonts packages/ui/fonts
git rm apps/web/src/fonts.css
```
Expected: `package.json` gains `"@tailwindcss/node": "4.3.3"`; `packages/ui/fonts/` holds the four woff2 files and both OFL texts.

- [ ] **Step 2: Write the failing tests**

Append to `packages/ui/src/tokens.test.ts` inside "motion, labels and fonts" (and read `fonts.css` at the top: `const fonts = readFileSync(new URL("./fonts.css", import.meta.url), "utf8");`, plus `existsSync` in the `node:fs` import):

```ts
  it("serves its own woff2 files", () => {
    expect(fonts).not.toMatch(/https?:\/\//);
    expect(fonts).toContain("font-display: swap");
    const files = [...fonts.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? "");
    expect(files).toHaveLength(4);
    for (const file of files) expect(existsSync(new URL(file, new URL("./fonts.css", import.meta.url))), file).toBe(true);
  });
```

`scripts/tailwind-compile.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";

const REPO = fileURLToPath(new URL("..", import.meta.url));
export const STYLES = join(REPO, "apps/web/src/styles.css");

/** Tailwind's selector escaping for a class name: every character outside [A-Za-z0-9_-] gets a backslash. */
export const escapeClass = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`);

/**
 * The web app's real stylesheet (Tailwind, @pap/ui tokens, utilities and fonts), compiled fresh: the returned
 * function builds the CSS for exactly the classes given. A fresh compiler per call keeps one test's classes out of
 * another's output.
 */
export async function compileStyles(): Promise<(candidates: readonly string[]) => string> {
  const compiler = await compile(readFileSync(STYLES, "utf8"), { base: dirname(STYLES), onDependency: () => {} });
  return (candidates) => compiler.build([...candidates]);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A rule whose selector starts with exactly this class (M3-RT-03): `.bg-surface` is not found inside `.bg-surface-2`,
 * `.w-` not inside `.w-full`, and `html[data-keyboard-open] .pb-safe` is not the `pb-safe` utility. A selector may
 * also start after `(` or `,` (`:where(.space-y-2 > …)`, selector lists).
 */
export const classRule = (className: string): RegExp =>
  new RegExp(`(?:^|[{};(,])\\s*\\.${escapeRegExp(escapeClass(className))}(?![\\w\\\\-])`);

/** The text from a class's selector to the end of its rule, or "" when the CSS has no rule for exactly that class. */
export function ruleOf(css: string, className: string): string {
  const match = classRule(className).exec(css);
  if (!match) return "";
  const at = match.index + match[0].indexOf(".");
  return css.slice(at, css.indexOf("}", at) + 1);
}
```

(`@tailwindcss/node`'s `compile` signature and the shape of its options: verify against the pinned `.d.ts`; `onDependency` is required in 4.x.)

`scripts/token-classes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { compileStyles, ruleOf } from "./tailwind-compile.ts";

async function rule(className: string): Promise<string> {
  const build = await compileStyles();
  return ruleOf(build([className]), className);
}

describe("the token utilities compile to the DESIGN.md variables", () => {
  it.each([
    ["bg-surface-2", "var(--surface-2)"],
    ["text-fg", "var(--text)"],
    ["text-muted", "var(--text-muted)"],
    ["bg-you-fill", "var(--you-fill)"],
    ["text-agent-ink", "var(--agent-ink)"],
    ["border-control-border", "var(--control-border)"],
    ["text-attn-title", "var(--attn-title)"],
    ["bg-panel", "var(--surface)"],
    ["text-attention", "var(--attn)"],
    ["p-s3", "var(--space-3)"],
    ["gap-s1", "var(--space-1)"],
    ["h-control", "var(--control-h)"],
    ["w-rail", "var(--rail-w)"],
    ["size-avatar", "var(--avatar-size)"],
    ["w-drawer-tree", "18.75rem"],
    ["min-w-pane", "20rem"],
    ["text-ui", "var(--size-ui)"],
    ["label-hud", "var(--label-transform)"],
    ["shadow-overlay", "var(--shadow-overlay)"],
    ["bg-grid", "var(--grid-size)"],
    ["h-app", "var(--app-viewport-height, 100dvh)"],
    ["pb-safe", "env(safe-area-inset-bottom"],
    ["duration-fast", "var(--motion-fast)"],
    ["max-w-chat", "var(--chat-max-width)"],
    ["rounded-sm", "2px"],
    ["rounded-md", "3px"],
  ])("%s → %s", async (className, expected) => {
    expect(await rule(className)).toContain(expected);
  });

  it("draws the focus ring on :focus-visible with the focus token", async () => {
    const css = (await compileStyles())(["focus-ring"]);
    expect(css).toMatch(/focus-visible/);
    expect(css).toContain("outline: 2px solid var(--focus-ring)");
    expect(css).toContain("outline-offset: 2px");
  });

  it("knows the state, hover and rail variants", async () => {
    const build = await compileStyles();
    expect(build(["state-open:opacity-100"])).toContain('[data-state="open"]');
    expect(build(["state-checked:bg-agent-fill"])).toContain('[data-state="checked"]');
    expect(build(["can-hover:hover:bg-surface-2"])).toContain("@media (hover: hover)");
    expect(build(["rail-right:flex-row-reverse"])).toContain('[data-rail="right"]');
  });

  it("compiles nothing for a default palette colour, and finds a rule by exact class only", async () => {
    expect(await rule("bg-red-500")).toBe("");
    expect(ruleOf(".bg-surface-2 { x: 1; }", "bg-surface")).toBe("");
    expect(ruleOf("html[data-keyboard-open] .pb-safe { padding-bottom: 0; }", "pb-safe")).toBe("");
  });
});
```

Add to `apps/web/src/build-output.int.test.ts`, inside the existing `describe`:

```ts
  it("ships CSS without native nesting, which Safari 16.4 cannot read", () => {
    expect(css).not.toMatch(/(^|[{;\s])&[:.[\s>+~]/);
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/tokens.test.ts scripts/token-classes.test.ts`
Expected: FAIL (`fonts.css` missing, `label-hud` produces no rule while `styles.css` does not import `utilities.css`).

- [ ] **Step 4: Implement**

`packages/ui/src/fonts.css`: the four `@font-face` rules of the deleted `apps/web/src/fonts.css`, unchanged except `src: url("../fonts/<file>.woff2") format("woff2");`, under the same header comment.

`packages/ui/package.json` `exports`: add `"./fonts.css": "./src/fonts.css"`.

`packages/ui/src/focus.ts`:

```ts
/** DESIGN.md §7.4 with ADR 0012: a 2 px solid --focus-ring outline, offset 2 px, on :focus-visible. Never removed. */
export const FOCUS_RING = "focus-ring";
```

`apps/web/src/styles.css`:

```css
@import "tailwindcss";
@import "@pap/ui/tokens.css";
@import "@pap/ui/utilities.css";
@import "@pap/ui/fonts.css";
@source "../../../packages/ui/src";

html,
body,
#root {
  height: 100%;
}

body {
  @apply bg-grid font-sans text-ui text-fg;
}
```

In `Button.test.tsx` and `TextField.test.tsx`, replace the three `focus-visible:…` expectations of the focus-ring cases with `expect(html).toContain("focus-ring")` (the rule itself is pinned by `token-classes.test.ts`).

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit packages/ui scripts/token-classes.test.ts && pnpm test:int apps/web/src/build-output.int.test.ts`
Expected: PASS. If `p-s3` or `w-drawer-tree` compile to nothing, apply ruling M3R7's fallback and keep the test list as is. If the initial bundle crosses `budgets.json`, apply the provisional-budget rule (Global Constraints).

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/ui apps/web/src/styles.css apps/web/src/build-output.int.test.ts scripts/tailwind-compile.ts scripts/token-classes.test.ts package.json pnpm-lock.yaml
git commit -m "feat(ui): self-hosted fonts in packages/ui, the token utilities in the web stylesheet, compile tests"
```

---

### Task 2: Design-system gates — no native `title`, no unknown classes, the React Compiler on `@pap/ui`

Three gates make "design-system lint clean on every screen" checkable without a browser (owner C1: in M3 they are the whole check; the runtime browser checks are deferred): an ESLint rule against the native `title` attribute (T3: `oxlint-plugin-t3code/rules/no-native-title-tooltip.ts`), a class-coverage test that fails on any class Tailwind cannot generate (T3: `shadcn/no-unknown-classes`; Orca: `config/oxlint-dead-classes.json`), and a React Compiler gate (R122, R128) so no component silently loses memoization.

**Files:**
- Modify: `eslint/pap-plugin.js`, `eslint/pap-plugin.test.js`, `eslint.config.js`
- Create: `scripts/class-coverage.ts`, `scripts/class-coverage.test.ts`
- Create: `apps/web/src/compiler-gate.test.ts`, `apps/web/src/compiler-pipeline.int.test.ts`

**Interfaces:**
- Consumes: `compileStyles`, `classRule` (Task 1b).
- Produces: rule `pap/no-native-title`; `classCandidates(file: string, text: string): Candidate[]`, `unknownClasses(root: string, files?: ReadonlyArray<{ file: string; text: string }>): Promise<Candidate[]>` with `interface Candidate { className: string; file: string; line: number }`; `M2_OWNED_UNTIL_P7`; the two compiler tests.

**Rulings (pre-dispatch):**
- The class-coverage gate reads only `className`, `cn()` and UPPER_CASE class constants (plan convention). [M3R9]
- A class counts as known only when the compiled CSS has a rule whose selector starts with exactly that class (`classRule`, M3-RT-03); a substring never counts. [M3R10]
- Both scans (this task and Task 3's literal gate) skip `apps/web/src/features/sessions/` until post-merge task P7, which removes the exclusion and fixes what it finds; a red gate with "do not fix" would block the task (M3-RT-24). [M3R11]
- The compiler gate passes the Babel plugin as an imported function, never by name (Babel resolves names from the repository root, where the plugin is not installed: M3-RT-04). [M3R12]

- [ ] **Step 1: Write the failing tests**

Append to `eslint/pap-plugin.test.js`:

```js
tester.run("no-native-title", pap.rules["no-native-title"], {
  valid: [
    { code: 'const x = <button aria-label="Close">x</button>;' },
    { code: 'const x = <iframe title="preview" />;' },
    { code: 'const x = <Tooltip title="ok"><b /></Tooltip>;' },
  ],
  invalid: [
    { code: 'const x = <button title="Close">x</button>;', errors: [{ messageId: "title" }] },
    { code: "const x = <span title={label}>x</span>;", errors: [{ messageId: "title" }] },
  ],
});
```

`scripts/class-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classCandidates, M2_OWNED_UNTIL_P7, unknownClasses } from "./class-coverage.ts";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

describe("class candidates", () => {
  it("reads className, cn() and UPPER_CASE class constants, nothing else", () => {
    const source = [
      'const VARIANTS = { primary: "bg-you-fill text-you-ink", ghost: "bg-transparent" } as const;',
      'const label = t("sessions.create");',
      'const FOCUS_RING = "focus-ring";',
      'const x = <div className={cn("flex gap-s2", open ? "state-open:opacity-100" : "hidden", busy && "opacity-50")} />;',
      'const y = <p className="text-ui text-muted">{"not a class"}</p>;',
      'const z = <i className={`w-${size} h-4`} />;',
    ].join("\n");
    const names = classCandidates("x.tsx", source).map((c) => c.className);
    expect(names).toEqual(expect.arrayContaining(["bg-you-fill", "text-you-ink", "bg-transparent", "focus-ring", "flex", "gap-s2", "state-open:opacity-100", "hidden", "opacity-50", "text-ui", "text-muted", "w-", "h-4"]));
    expect(names).not.toContain("sessions.create");
    expect(names).not.toContain("not");
  });
});

describe("class coverage", () => {
  it("every class in packages/ui and apps/web compiles to a rule", async () => {
    const unknown = await unknownClasses(REPO);
    expect(unknown.map((c) => `${c.file}:${c.line} ${c.className}`)).toEqual([]);
  }, 60_000);

  it("catches a typo and a dynamic fragment", async () => {
    const files = [{ file: "fixture.tsx", text: 'const a = <b className="bg-surfce p-s2" />; const b = <i className={`w-${n}`} />;' }];
    const unknown = await unknownClasses(REPO, files);
    expect(unknown.map((c) => c.className).sort()).toEqual(["bg-surfce", "w-"]);
  });

  it("reports a fragment or a truncated name even when a longer class compiles next to it (M3-RT-03)", async () => {
    const files = [{ file: "fixture.tsx", text: 'const a = <b className={`w-full w-${n}`} />; const b = <i className="text-muted text-mut bg-surface-2 bg-surfac" />;' }];
    const unknown = await unknownClasses(REPO, files);
    expect(unknown.map((c) => c.className).sort()).toEqual(["bg-surfac", "text-mut", "w-"]);
  });

  it("leaves M2's session screens to post-merge task P7", () => {
    expect(M2_OWNED_UNTIL_P7.test("apps/web/src/features/sessions/SessionScreen.tsx")).toBe(true);
    expect(M2_OWNED_UNTIL_P7.test("apps/web/src/features/auth/LoginScreen.tsx")).toBe(false);
  });
});
```

`apps/web/src/compiler-gate.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import reactCompiler from "babel-plugin-react-compiler";
import { describe, expect, it } from "vitest";

// R122 / R128: the React Compiler skips a component it cannot prove safe without saying so. Every component file
// of the UI package and the web app goes through it here; any CompileError or PipelineError fails the gate.
const REPO = resolve(import.meta.dirname, "../../..");
const ROOTS = ["packages/ui/src", "apps/web/src"];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "testing" ? [] : tsxFiles(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

interface CompilerEvent {
  readonly kind: string;
  readonly detail?: unknown;
  readonly data?: unknown;
}

async function compilerEvents(path: string): Promise<CompilerEvent[]> {
  const events: CompilerEvent[] = [];
  await transformAsync(readFileSync(path, "utf8"), {
    filename: path,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    // The plugin itself, not its name: Babel would resolve a name from the repository root (M3-RT-04).
    plugins: [[reactCompiler, { panicThreshold: "none", logger: { logEvent: (_file: string | null, event: CompilerEvent) => events.push(event) } }]],
  });
  return events;
}

const files = ROOTS.flatMap((root) => tsxFiles(join(REPO, root))).map((path) => relative(REPO, path));

describe("React Compiler gate", () => {
  it("covers the UI package and the web app", () => {
    expect(files.some((file) => file.startsWith("packages/ui/"))).toBe(true);
    expect(files.some((file) => file.startsWith("apps/web/"))).toBe(true);
  });

  it.each(files)("%s compiles with no bailout", async (file) => {
    const failures = (await compilerEvents(join(REPO, file))).filter((e) => e.kind === "CompileError" || e.kind === "PipelineError");
    expect(failures.map((e) => JSON.stringify(e.detail ?? e.data ?? e).slice(0, 400))).toEqual([]);
  });
});
```

`apps/web/src/compiler-pipeline.int.test.ts`:

```ts
import { join, resolve } from "node:path";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");

// The gate above runs Babel directly; this proves the app's own Vite pipeline compiles files of @pap/ui too
// (R128): a component of the package, built through apps/web/vite.config.ts, imports the compiler runtime.
describe("the web build runs the React Compiler on @pap/ui", () => {
  it("compiles a primitive of packages/ui", async () => {
    const output = (await build({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      build: {
        write: false,
        lib: { entry: join(repoRoot, "packages/ui/src/ai/ApprovalCard.tsx"), formats: ["es"], fileName: "probe" },
        rollupOptions: { external: (id) => /^(react|react-dom|radix-ui|lucide-react)(\/|$)/.test(id) },
      },
    })) as Rollup.RollupOutput[];
    const code = output.flatMap((o) => o.output).map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n");
    expect(code).toMatch(/react\/compiler-runtime/);
  }, 60_000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit eslint scripts/class-coverage.test.ts apps/web/src/compiler-gate.test.ts && pnpm test:int apps/web/src/compiler-pipeline.int.test.ts`
Expected: FAIL (rule and module missing). The compiler tests may already pass: that is the expected state of M1 code (R122 was applied); keep them as a gate. (The default export of `babel-plugin-react-compiler` is the plugin function: verify against the pinned `.d.ts`; if the package exposes it under another name, import that one. `babel-plugin-react-compiler` and `@babel/core` are devDependencies of `apps/web`, which is where this test lives.)

- [ ] **Step 3: Implement**

In `eslint/pap-plugin.js`, add the rule and register it as `"no-native-title": noNativeTitle`:

```js
// DESIGN.md §7.1: icon-only controls carry a tooltip; the native title attribute is not used (T3:
// oxlint-plugin-t3code/rules/no-native-title-tooltip.ts). Embedded content keeps title: it names the frame there.
const TITLE_EXEMPT = new Set(["iframe", "embed", "frame", "object", "math"]);

const noNativeTitle = {
  meta: {
    type: "problem",
    messages: { title: "Do not use the native title attribute: use the Tooltip of @pap/ui (DESIGN.md §7.1)." },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !/^[a-z]/.test(node.name.name) || TITLE_EXEMPT.has(node.name.name)) return;
        for (const attribute of node.attributes) {
          if (attribute.type === "JSXAttribute" && attribute.name.name === "title") {
            context.report({ node: attribute, messageId: "title" });
          }
        }
      },
    };
  },
};
```

In `eslint.config.js`, in the block that enables `pap/no-arbitrary-values` for `apps/web/src/**` and `packages/ui/src/**`, add `"pap/no-native-title": "error"`.

`scripts/class-coverage.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { classRule, compileStyles } from "./tailwind-compile.ts";

export interface Candidate {
  readonly className: string;
  readonly file: string;
  readonly line: number;
}

// Where class lists may live (plan convention): className, cn(...), and UPPER_CASE constants with these endings.
const CLASS_CONSTANT = /^[A-Z][A-Z0-9_]*(?:CLASSES|VARIANTS|SIZES|TONES|STYLE|RING)$/;
// Markers that compile to nothing on purpose, and the plain classes tokens.css defines.
const NOT_UTILITIES = /^(?:group|peer)(?:\/[\w-]+)?$/;
const PLAIN_CLASSES = new Set(["theme-swap"]);
const SCANNED = /^(?:packages\/ui\/src|apps\/web\/src)\/.*\.tsx?$/;
/** M2's folder: scanned by post-merge task P7, which deletes this exclusion (M3-RT-24). */
export const M2_OWNED_UNTIL_P7 = /^apps\/web\/src\/features\/sessions\//;

export function classCandidates(file: string, text: string): Candidate[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Candidate[] = [];
  const add = (node: ts.Node, value: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    for (const className of value.split(/\s+/).filter(Boolean)) out.push({ className, file, line });
  };
  // Strings that end up in a class list: branches and operands, never conditions or other calls' arguments.
  const strings = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text);
      for (const span of node.templateSpans) add(span.literal, span.literal.text);
    } else if (ts.isConditionalExpression(node)) {
      strings(node.whenTrue);
      strings(node.whenFalse);
    } else if (ts.isBinaryExpression(node)) {
      strings(node.right);
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) strings(node.left);
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) strings(node.expression);
    else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(strings);
    else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) if (ts.isPropertyAssignment(property)) strings(property.initializer);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cn") node.arguments.forEach(strings);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "className" && node.initializer) {
      strings(ts.isJsxExpression(node.initializer) && node.initializer.expression ? node.initializer.expression : node.initializer);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cn") {
      node.arguments.forEach(strings);
      return;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && CLASS_CONSTANT.test(node.name.text) && node.initializer) {
      strings(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out.filter((c) => !NOT_UTILITIES.test(c.className) && !PLAIN_CLASSES.has(c.className));
}

function trackedSources(root: string): Array<{ file: string; text: string }> {
  // Tracked and new (untracked, not ignored) files: a task's own new files are checked before its commit.
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => SCANNED.test(file) && !M2_OWNED_UNTIL_P7.test(file) && !file.includes(".test.") && !file.includes("/testing/") && existsSync(join(root, file)))
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

/** Classes used in the UI code that Tailwind and tokens.css do not generate (typos, stale names, dynamic fragments). */
export async function unknownClasses(root: string, files: ReadonlyArray<{ file: string; text: string }> = trackedSources(root)): Promise<Candidate[]> {
  const candidates = files.flatMap(({ file, text }) => classCandidates(file, text));
  const build = await compileStyles();
  const css = build([...new Set(candidates.map((c) => c.className))]);
  return candidates.filter((c) => !classRule(c.className).test(css));
}
```

Add `scripts/class-coverage.ts` nothing to `knip.json` (the root workspace entry already covers `scripts/*.ts`).

- [ ] **Step 4: Run the tests and fix what they find in existing code**

Run: `pnpm test:unit eslint scripts/class-coverage.test.ts apps/web/src/compiler-gate.test.ts && pnpm test:int apps/web/src/compiler-pipeline.int.test.ts && pnpm lint`
Expected: PASS. Mutation checks (the gates must be seen failing): add a temporary `packages/ui/src/probe.tsx` component that reads `ref.current` during render → the compiler gate names it; add `className="bg-surfce"` to it → class coverage names it; add `<span title="x">` → `pnpm lint` reports `pap/no-native-title`; replace `classRule(...).test(css)` by `css.includes(...)` once → the M3-RT-03 case fails; delete the probe. If class coverage reports classes in M1 code, fix them in files M3 owns (M2's `features/sessions` is excluded until P7). If the pipeline test fails because the Babel plugin skips files outside `apps/web`, pass the plugin an explicit include covering `packages/ui/src` (see `@rolldown/plugin-babel`'s options in its `.d.ts`) and add `expect(...)` on that option in `apps/web/src/vite-config.test.ts`.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add eslint scripts/class-coverage.ts scripts/class-coverage.test.ts apps/web/src/compiler-gate.test.ts apps/web/src/compiler-pipeline.int.test.ts eslint.config.js
git commit -m "test(ui): design-system gates for native title, unknown classes and the React Compiler"
```

---

### Task 3: i18n structure — reactive locale, namespaced catalogs, server texts, literal-string gate

The M1 `t()` reads a module variable, so a component the React Compiler memoized keeps its old strings after a switch (R128). `useT()` subscribes to the locale. M3's strings go into namespace files spread into `en`/`fr` so M2's `sessions.*` block in `en.ts`/`fr.ts` never collides with them. A literal-string gate (Orca: `config/scripts/audit-localization-coverage.mjs`) keeps "every string through the i18n layer" (DESIGN §11) true.

**Files:**
- Modify: `apps/web/src/i18n/index.ts`, `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/fr.ts`, `apps/web/src/i18n/i18n.test.ts`
- Create: `apps/web/src/i18n/catalog/shell.ts`, `catalog/settings.ts`, `catalog/commands.ts`, `catalog/gallery.ts`, `apps/web/src/i18n/server-text.ts`, `apps/web/src/i18n/server-text.test.ts`
- Create: `scripts/literal-coverage.ts`, `scripts/literal-coverage.test.ts`, `scripts/literal-allowlist.json`
- Create: `apps/web/src/lib/report.ts`, `apps/web/src/lib/report.test.ts`; modify `eslint.config.js` (boundary element `web-lib`)

**Interfaces:**
- Consumes: the existing catalog types (`MessageKey`, `Locale`, `translate`, `t`, `errorKey`).
- Produces:
  - `getLocale(): Locale`, `onLocaleChange(listener: () => void): () => void`, `useLocale(): Locale`, `type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string`, `useT(): Translate`, `switchLocale(locale: Locale, deps?: { storage?: Pick<Storage, "setItem">; root?: HTMLElement }): boolean` (false when the browser refused to store the choice: the caller says so on screen); `setLocale` now notifies listeners.
  - `type ClientIssue = "storage_refused" | "boot_cache_refused" | "appearance_boot_failed" | "setting_load_failed" | "setting_save_failed" | "keybindings_invalid" | "sessions_list_failed" | "lazy_chunk_failed"`, `reportClientIssue(code: ClientIssue, deps?: { warn?(line: string): void; now?(): number }): void` — one `console.warn("pap: <code>")` per code per 10 s, nothing else in the line (no user data). Every client-side `catch` in M3 code either maps the failure to something the screen shows or calls this (checklist: errors are never silent).
  - Boundary element `web-lib` (`apps/web/src/lib`): may import `web-lib`, `web-runtime`, `contracts`; `web-feature`, `web-routes`, `web-root` and `web-i18n` may import it.
  - Namespace catalogs, each `export const <ns>En = {…} as const; export const <ns>Fr: { readonly [K in keyof typeof <ns>En]: string } = {…};` — later tasks append keys under their prefix: `shell.*`, `settings.*`, `commands.*`, `gallery.*`, `ui.*` (in `shell.ts`), `server.*` (in `shell.ts`).
  - `serverText(text: string, locale?: Locale): string`.
  - `checkLiterals(root: string): Literal[]`, `literalsIn(file: string, text: string): Literal[]` with `interface Literal { file: string; line: number; text: string }`.

**Rulings (pre-dispatch):**
- `IDENTICAL_IN_FR` names keys later tasks create (harmless before they exist). M2 adds no key whose French equals the English (agreement 4: "Pour la session", "{index} sur {total}"); the rebase re-runs `i18n.test.ts` and P7 adds any identical M2 key with a reason. [M3R13]
- The catalog spreads leave M2's `sessions.*` block untouched; M2 keeps all its keys inside its own delimited block (agreement 4). [M3R14]
- The language stays per device (`pap.locale` in `localStorage`, owner R3-3); it is not an account setting. [M3R15]
- The literal gate skips `apps/web/src/features/sessions/` until P7, like the class gate (M3R11). [M3R11]

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/i18n/i18n.test.ts` (and turn the file into `// @vitest-environment happy-dom` as its first line):

```tsx
import { act } from "react";
import { mount, text } from "../testing/dom.ts";
import { getLocale, onLocaleChange, setLocale, switchLocale, useT } from "./index.ts";

// Keys whose French is the same word (endonyms, product and font names). Every other key must differ.
const IDENTICAL_IN_FR = new Set(["app.name", "settings.language.en", "settings.language.fr", "settings.appearance.fontManrope", "settings.appearance.fontJetbrains", "shell.pane.terminal", "commands.palette.title"]);

describe("reactive locale (R128)", () => {
  it("re-renders a component that reads useT when the locale changes", async () => {
    setLocale("en");
    function Probe() {
      const t = useT();
      return <p>{t("gate.retry")}</p>;
    }
    const page = await mount(<Probe />);
    expect(text(page.container)).toBe("Retry");
    await act(async () => setLocale("fr"));
    expect(text(page.container)).toBe("Réessayer");
    await act(async () => setLocale("en"));
    await page.unmount();
  });

  it("tells listeners once per real change", () => {
    setLocale("en");
    let calls = 0;
    const stop = onLocaleChange(() => calls++);
    setLocale("en");
    setLocale("fr");
    stop();
    setLocale("en");
    expect(calls).toBe(1);
  });

  it("switchLocale stores the choice and sets the document language", () => {
    const stored: Record<string, string> = {};
    expect(switchLocale("fr", { storage: { setItem: (k, v) => void (stored[k] = v) }, root: document.documentElement })).toBe(true);
    expect([getLocale(), stored["pap.locale"], document.documentElement.lang]).toEqual(["fr", "fr", "fr"]);
    switchLocale("en", { storage: { setItem: () => {} }, root: document.documentElement });
  });

  it("switches for this page and says so when the browser refuses to store the choice", () => {
    const refused = { setItem: () => { throw new Error("denied"); } };
    expect(switchLocale("fr", { storage: refused, root: document.documentElement })).toBe(false);
    expect(getLocale()).toBe("fr");
    switchLocale("en", { storage: { setItem: () => {} }, root: document.documentElement });
  });
});
```

and replace the body of the existing "translates every key into French" test with:

```ts
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(fr[key], key).toBeTruthy();
      if (!IDENTICAL_IN_FR.has(key)) expect(fr[key], key).not.toBe(en[key]);
    }
```

`apps/web/src/i18n/server-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serverText } from "./server-text.ts";

describe("server texts (R128)", () => {
  it.each([
    ["A message was too large to stream.", "Un message était trop volumineux pour être diffusé."],
    ["An extension failed.", "Une extension a échoué."],
    ["An extension failed during tool_call.", "Une extension a échoué pendant tool_call."],
    ["Agent process exited with code 70.", "Le processus de l'agent s'est arrêté avec le code 70."],
    ["Agent process stopped by SIGTERM.", "Le processus de l'agent a été arrêté par SIGTERM."],
    ["Agent process killed (SIGKILL), possibly out of memory.", "Le processus de l'agent a été tué (SIGKILL), peut-être faute de mémoire."],
  ])("translates %s", (english, french) => {
    expect(serverText(english, "en")).toBe(english);
    expect(serverText(english, "fr")).toBe(french);
  });

  it("shows an unknown sentence as sent, clipped to 500 characters", () => {
    expect(serverText("Something new.", "fr")).toBe("Something new.");
    expect(serverText("x".repeat(600), "fr")).toHaveLength(501);
  });
});
```

`apps/web/src/lib/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reportClientIssue } from "./report.ts";

describe("client issues", () => {
  it("warns once per code per 10 s, with the code only", () => {
    const lines: string[] = [];
    let now = 1_000_000;
    const deps = { warn: (line: string) => lines.push(line), now: () => now };
    reportClientIssue("storage_refused", deps);
    reportClientIssue("storage_refused", deps);
    reportClientIssue("boot_cache_refused", deps);
    now += 10_000;
    reportClientIssue("storage_refused", deps);
    expect(lines).toEqual(["pap: storage_refused", "pap: boot_cache_refused", "pap: storage_refused"]);
  });
});
```

`scripts/literal-coverage.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkLiterals, literalsIn } from "./literal-coverage.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

describe("literal UI strings (DESIGN.md §11)", () => {
  it("finds JSX text and labelling attributes, not code or symbols", () => {
    const found = literalsIn("x.tsx", [
      "const a = <p>Save changes</p>;",
      'const b = <button aria-label="Close" />;',
      'const c = <input placeholder="Search" />;',
      "const d = <span>{count} · ⌘</span>;",
      'const e = <div data-slot="button" className="flex" />;',
      "const f = <p>{t(\"key\")}</p>;",
    ].join("\n"));
    expect(found.map((l) => l.text)).toEqual(["Save changes", "Close", "Search"]);
  });

  it("packages/ui and apps/web have none outside the allowlist", () => {
    expect(checkLiterals(REPO).map((l) => `${l.file}:${l.line} ${l.text}`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/i18n scripts/literal-coverage.test.ts`
Expected: FAIL (`useT`, `server-text.ts`, `literal-coverage.ts` missing).

- [ ] **Step 3: Implement**

Append to `apps/web/src/i18n/index.ts` (and change `setLocale`):

```ts
import { useCallback, useSyncExternalStore } from "react";
import { reportClientIssue } from "../lib/report.ts";

const listeners = new Set<() => void>();

export function setLocale(locale: Locale): void {
  if (current === locale) return;
  current = locale;
  for (const listener of [...listeners]) listener();
}

export const getLocale = (): Locale => current;

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The locale as React state: components that read it re-render when it changes, the Compiler included. */
export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

/** `t` for components. Plain `t()` stays for code outside React (view-models, toasts built in handlers). */
export function useT(): Translate {
  const locale = useLocale();
  return useCallback((key, vars) => translate(locale, key, vars), [locale]);
}

/** Settings › Language: remembered on this device, applied without a reload. False: applied to this page only. */
export function switchLocale(
  locale: Locale,
  deps: { storage?: Pick<Storage, "setItem">; root?: HTMLElement } = {},
): boolean {
  let stored = true;
  try {
    (deps.storage ?? localStorage).setItem("pap.locale", locale);
  } catch {
    stored = false;
    reportClientIssue("storage_refused");
  }
  (deps.root ?? document.documentElement).lang = locale;
  setLocale(locale);
  return stored;
}
```

(Remove the old `setLocale`; keep `current`, `pickLocale`, `translate`, `t`, `errorKey`, `CLIENT_ERROR_CODES` as they are.)

`apps/web/src/i18n/catalog/shell.ts` (later tasks append; this task adds the server texts and the language names Task 24 uses):

```ts
export const shellEn = {
  "server.notice.messageTooLarge": "A message was too large to stream.",
  "server.notice.dialogTooLarge": "An extension asked a question that was too large to show. It was cancelled.",
  "server.notice.dialogLimit": "An extension asked a question while too many were waiting. It was cancelled.",
  "server.notice.extensionFailed": "An extension failed.",
  "server.notice.extensionFailedDuring": "An extension failed during {event}.",
  "server.cause.stopped": "Agent process stopped.",
  "server.cause.exitCode": "Agent process exited with code {code}.",
  "server.cause.signal": "Agent process stopped by {signal}.",
  "server.cause.signalUnknown": "Agent process stopped by a signal.",
  "server.cause.killed": "Agent process killed (SIGKILL), possibly out of memory.",
  "server.cause.spawnFailure": "Agent process could not start.",
} as const;

export const shellFr: { readonly [K in keyof typeof shellEn]: string } = {
  "server.notice.messageTooLarge": "Un message était trop volumineux pour être diffusé.",
  "server.notice.dialogTooLarge": "Une extension a posé une question trop volumineuse pour être affichée. Elle a été annulée.",
  "server.notice.dialogLimit": "Une extension a posé une question alors que trop d'autres attendaient. Elle a été annulée.",
  "server.notice.extensionFailed": "Une extension a échoué.",
  "server.notice.extensionFailedDuring": "Une extension a échoué pendant {event}.",
  "server.cause.stopped": "Le processus de l'agent s'est arrêté.",
  "server.cause.exitCode": "Le processus de l'agent s'est arrêté avec le code {code}.",
  "server.cause.signal": "Le processus de l'agent a été arrêté par {signal}.",
  "server.cause.signalUnknown": "Le processus de l'agent a été arrêté par un signal.",
  "server.cause.killed": "Le processus de l'agent a été tué (SIGKILL), peut-être faute de mémoire.",
  "server.cause.spawnFailure": "Le processus de l'agent n'a pas pu démarrer.",
};
```

`catalog/settings.ts` starts with:

```ts
export const settingsEn = {
  "settings.language.en": "English",
  "settings.language.fr": "Français",
} as const;

export const settingsFr: { readonly [K in keyof typeof settingsEn]: string } = {
  "settings.language.en": "English",
  "settings.language.fr": "Français",
};
```

`catalog/commands.ts` and `catalog/gallery.ts` start with one key each so the spread compiles: `"commands.palette.title": "⌘K"` (same in fr, in `IDENTICAL_IN_FR`) and `"gallery.title": "UI gallery"` / `"Galerie de l'interface"`.

`en.ts`: add after the existing import line (none today: add at the top)

```ts
import { commandsEn } from "./catalog/commands.ts";
import { galleryEn } from "./catalog/gallery.ts";
import { settingsEn } from "./catalog/settings.ts";
import { shellEn } from "./catalog/shell.ts";
```

and make the first four entries of the object `...shellEn, ...settingsEn, ...commandsEn, ...galleryEn,`. Same in `fr.ts` with the `*Fr` objects (its type annotation stays `{ readonly [K in keyof typeof en]: string }`, so a missing French key is a type error). Existing keys stay where they are: M2 adds its `sessions.*` block below them.

`apps/web/src/i18n/server-text.ts`:

```ts
import { getLocale, translate, type Locale, type MessageKey } from "./index.ts";

// The daemon's notice and cause sentences are English today (M1 contracts carry text, not codes). Known sentences
// map to a key; anything else is shown as sent, clipped. Post-merge task P4 moves the contract to codes.
const MAX = 500;
const PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly key: MessageKey; readonly vars?: readonly string[] }> = [
  { re: /^A message was too large to stream\.$/, key: "server.notice.messageTooLarge" },
  { re: /^An extension asked a question that was too large to show\. It was cancelled\.$/, key: "server.notice.dialogTooLarge" },
  { re: /^An extension asked a question while too many were waiting\. It was cancelled\.$/, key: "server.notice.dialogLimit" },
  { re: /^An extension failed\.$/, key: "server.notice.extensionFailed" },
  { re: /^An extension failed during ([\w:.-]{1,64})\.$/, key: "server.notice.extensionFailedDuring", vars: ["event"] },
  { re: /^Agent process stopped\.$/, key: "server.cause.stopped" },
  { re: /^Agent process exited with code (-?\d{1,5}|unknown)\.$/, key: "server.cause.exitCode", vars: ["code"] },
  { re: /^Agent process stopped by (SIG[A-Z0-9]{1,12})\.$/, key: "server.cause.signal", vars: ["signal"] },
  { re: /^Agent process stopped by a signal\.$/, key: "server.cause.signalUnknown" },
  { re: /^Agent process killed \(SIGKILL\), possibly out of memory\.$/, key: "server.cause.killed" },
  { re: /^Agent process could not start\.$/, key: "server.cause.spawnFailure" },
];

export function serverText(text: string, locale: Locale = getLocale()): string {
  for (const { re, key, vars = [] } of PATTERNS) {
    const match = re.exec(text);
    if (match) return translate(locale, key, Object.fromEntries(vars.map((name, i) => [name, match[i + 1] ?? ""])));
  }
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
}
```

`apps/web/src/lib/report.ts`:

```ts
export type ClientIssue =
  | "storage_refused"
  | "boot_cache_refused"
  | "appearance_boot_failed"
  | "setting_load_failed"
  | "setting_save_failed"
  | "keybindings_invalid"
  | "sessions_list_failed"
  | "lazy_chunk_failed";

const QUIET_MS = 10_000;
// Bounded by the closed union above.
const last = new Map<ClientIssue, number>();
const CONSOLE = { warn: (line: string) => console.warn(line), now: () => Date.now() };

/** A client-side failure nobody sees on screen: one bounded console line per code per 10 s, never user data. */
export function reportClientIssue(code: ClientIssue, deps: { warn?(line: string): void; now?(): number } = {}): void {
  const warn = deps.warn ?? CONSOLE.warn;
  const now = (deps.now ?? CONSOLE.now)();
  const previous = last.get(code);
  if (previous !== undefined && now - previous < QUIET_MS) return;
  last.set(code, now);
  warn(`pap: ${code}`);
}
```

In `eslint.config.js`, add the element `{ type: "web-lib", pattern: "apps/web/src/lib" }`, the rule `{ from: "web-lib", allow: ["web-lib", "web-runtime", "contracts"] }`, and `"web-lib"` to the allow lists of `web-feature`, `web-routes`, `web-root` and `web-i18n`.

`scripts/literal-coverage.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export interface Literal {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

// Attributes a person reads or hears (Orca's coverage audit list, plus our own label props).
const LABEL_ATTRIBUTES = new Set(["aria-label", "aria-description", "placeholder", "alt", "label", "title", "stageLabel"]);
const LETTER = /\p{L}/u;
// The gallery shows sample content (data, not UI text); tests and test helpers are not shipped.
const SCANNED = /^(?:packages\/ui\/src|apps\/web\/src)\/.*\.tsx$/;
// M2's folder waits for post-merge task P7, which deletes that alternative (M3-RT-24).
const SKIPPED = /\.test\.|\/testing\/|^apps\/web\/src\/gallery\/|^apps\/web\/src\/features\/sessions\//;

export function literalsIn(file: string, text: string): Literal[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Literal[] = [];
  const push = (node: ts.Node, value: string): void => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (LETTER.test(trimmed)) out.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: trimmed });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) push(node, node.text);
    else if (ts.isJsxAttribute(node) && LABEL_ATTRIBUTES.has(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) push(node, node.initializer.text);
    else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression) && ts.isJsxElement(node.parent)) push(node, node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export function checkLiterals(root: string): Literal[] {
  const allowed = JSON.parse(readFileSync(join(root, "scripts/literal-allowlist.json"), "utf8")) as Array<{ file: string; text: string }>;
  const isAllowed = (l: Literal) => allowed.some((a) => a.file === l.file && a.text === l.text);
  // Tracked and new (untracked, not ignored) files, so a task's own new screens are checked before its commit.
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => SCANNED.test(file) && !SKIPPED.test(file) && existsSync(join(root, file)))
    .flatMap((file) => literalsIn(file, readFileSync(join(root, file), "utf8")))
    .filter((literal) => !isAllowed(literal));
}
```

`scripts/literal-allowlist.json`: `[]` (an entry is `{ "file": "...", "text": "...", "reason": "..." }`).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web/src/i18n apps/web/src/lib scripts/literal-coverage.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS. M2's folder is skipped until P7; a literal anywhere else is fixed through the i18n layer, never allowlisted without a reason.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/i18n apps/web/src/lib eslint.config.js scripts/literal-coverage.ts scripts/literal-coverage.test.ts scripts/literal-allowlist.json
git commit -m "feat(web): reactive locale, namespaced catalogs, server texts and a literal-string gate"
```

---
# Phase 2 — Primitives (`packages/ui`)

All primitives follow DESIGN.md §9.1: Radix underneath (`radix-ui`, unified package), owned look, `variant`/`size` props, no `className`/`style` props, strings only through props (the literal gate of Task 3 scans `packages/ui`), `data-slot` on the root. Tests render with `apps/web`-style helpers: `packages/ui` tests import `mount`, `click`, `press` from a new `packages/ui/src/testing/dom.ts` (a copy of the four functions of `apps/web/src/testing/dom.ts` they need; `packages/ui` cannot import the web app).

### Task 4: Icon, Spinner, ProgressBar, feedback timing, number formats

**Files:**
- Create: `packages/ui/src/icons.ts`, `packages/ui/src/primitives/Icon.tsx`, `packages/ui/src/primitives/Spinner.tsx`, `packages/ui/src/primitives/ProgressBar.tsx`, `packages/ui/src/primitives/ProgressBar.test.tsx`, `packages/ui/src/feedback.ts`, `packages/ui/src/feedback.test.tsx`, `packages/ui/src/format.ts`, `packages/ui/src/format.test.ts`, `packages/ui/src/testing/dom.ts`
- Modify: `packages/ui/src/utilities.css` (reduced motion stops `animate-spin` too), `packages/ui/src/tokens.test.ts`, `packages/ui/package.json` (`lucide-react`), `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: Task 1a utilities.
- Produces:
  - `Icon({ icon: IconGlyph; size?: 14 | 16 | 20 | 28; label?: string })`, `type IconGlyph`, and the curated glyphs `IconAccount, IconAgents, IconAppearance, IconBack, IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconClose, IconCopy, IconDot, IconExport, IconHourglass, IconImport, IconInbox, IconKeyboard, IconLanguage, IconLists, IconMore, IconPlus, IconSearch, IconSettings, IconSignOut, IconSpinner, IconSplit, IconTree, IconUndo, IconWarning, IconWork`.
  - `Spinner({ label?: string })`, `ProgressBar({ value?: number | null; max?: number; label: string; tone?: "agent" | "you" })`.
  - `type FeedbackPhase = "idle" | "quiet" | "disabled" | "spinner" | "stage"`, `feedbackPhase(elapsedMs: number | null, remote: boolean): FeedbackPhase`, `usePendingFeedback(since: number | null, options?: { remote?: boolean; clock?: { now(): number } }): FeedbackPhase`, `usePendingAction(clock?): { since: number | null; run<T>(action: () => Promise<T>): Promise<T | undefined> }`.
  - `formatCost(usd: number): string`, `formatDuration(ms: number): string`, `formatDiffCounts(added: number, removed: number): string`.

**Rulings (pre-dispatch):**
- lucide-react names differ across versions: the `Icon*` aliases are the stable API; the upstream name may change to whatever the pinned version calls it. [M3R16]
- A spinner turns while visible: DESIGN §7.2 "nothing repaints continuously" is read as "no idle animation"; the 1–3 s spinner of §7.3 is bounded by the action and is static under reduced motion. [M3R17]
- `lucide-react` is a dependency of `@pap/ui` only: the web app imports `IconGlyph` and the glyphs from `@pap/ui` (a web dependency would be unused for knip, M3-RT-25). [M3R18]
- Number formats and the progress bar never print `NaN` or report a value outside their range (M3-RT-38). [M3R19]

- [ ] **Step 1: Add lucide-react**

Run: `pnpm --filter @pap/ui add -E lucide-react`
(Only `@pap/ui` depends on it; the web app imports `IconGlyph` and every glyph through `@pap/ui`.)

- [ ] **Step 2: Write the failing tests**

`packages/ui/src/feedback.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackPhase, usePendingFeedback } from "./feedback.ts";
import { mount } from "./testing/dom.ts";

describe("feedback timing (DESIGN.md §7.3, Orca STYLEGUIDE UX rule 1)", () => {
  it.each([
    [null, false, "idle"],
    [50, false, "quiet"],
    [100, false, "disabled"],
    [999, false, "disabled"],
    [1000, false, "spinner"],
    [2999, false, "spinner"],
    [3000, false, "stage"],
    [0, true, "disabled"],
    [199, true, "disabled"],
    [200, true, "spinner"],
    [3000, true, "stage"],
  ] as const)("%s ms (remote %s) → %s", (elapsed, remote, phase) => {
    expect(feedbackPhase(elapsed, remote)).toBe(phase);
  });
});

describe("usePendingFeedback", () => {
  let now = 0;
  const clock = { now: () => now };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Probe({ since, remote }: { since: number | null; remote: boolean }) {
    return <p>{usePendingFeedback(since, { remote, clock })}</p>;
  }

  it("walks a remote action through disabled, spinner and stage, and back to idle", async () => {
    now = 1000;
    const page = await mount(<Probe since={1000} remote />);
    expect(page.container.textContent).toBe("disabled");
    await act(async () => {
      now = 1200;
      vi.advanceTimersByTime(200);
    });
    expect(page.container.textContent).toBe("spinner");
    await act(async () => {
      now = 4000;
      vi.advanceTimersByTime(2800);
    });
    expect(page.container.textContent).toBe("stage");
    await page.rerender(<Probe since={null} remote />);
    expect(page.container.textContent).toBe("idle");
    await page.unmount();
  });

  it("keeps a local action quiet for its first 100 ms", async () => {
    now = 0;
    const page = await mount(<Probe since={0} remote={false} />);
    expect(page.container.textContent).toBe("quiet");
    await act(async () => {
      now = 100;
      vi.advanceTimersByTime(100);
    });
    expect(page.container.textContent).toBe("disabled");
    await page.unmount();
  });
});
```

`packages/ui/src/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatCost, formatDiffCounts, formatDuration } from "./format.ts";

describe("number formats (DESIGN.md §11)", () => {
  it("writes costs as $0.00", () => {
    expect([formatCost(0), formatCost(1.234), formatCost(0.005), formatCost(-1)]).toEqual(["$0.00", "$1.23", "$0.01", "$0.00"]);
    expect([formatCost(Number.NaN), formatCost(Number.POSITIVE_INFINITY)]).toEqual(["$0.00", "$0.00"]);
  });
  it("writes durations as 00:07 under a minute, 3m40 above, 1h05 above an hour", () => {
    expect([formatDuration(7_000), formatDuration(220_000), formatDuration(3_900_000), formatDuration(-5), formatDuration(Number.NaN)]).toEqual(["00:07", "3m40", "1h05", "00:00", "00:00"]);
  });
  it("writes diff counts with a true minus sign", () => {
    expect(formatDiffCounts(214, 38)).toBe("+214 −38");
  });
});
```

`packages/ui/src/primitives/ProgressBar.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar.tsx";

describe("ProgressBar", () => {
  it("is determinate with a value, clamped to its range", () => {
    const html = renderToStaticMarkup(<ProgressBar value={150} max={100} label="Budget" />);
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("width:100%");
  });
  it("is the thin indeterminate bar without one (the running tool card)", () => {
    const html = renderToStaticMarkup(<ProgressBar label="Running" />);
    expect(html).toContain("animate-indeterminate");
    expect(html).not.toContain("aria-valuenow");
  });
});
```

Append to `packages/ui/src/tokens.test.ts` inside "motion, labels and fonts":

```ts
  it("stops spinners as well as the indeterminate bar under reduced motion", () => {
    expect(utilities).toContain('[data-motion="none"] .animate-spin');
    expect(utilities).toContain('[data-motion="system"] .animate-spin');
  });
```

`packages/ui/src/testing/dom.ts`: copy `mount`, `click`, `press` and the `IS_REACT_ACT_ENVIRONMENT` line from `apps/web/src/testing/dom.ts`, and give `Mounted` a `rerender(element: ReactElement): Promise<void>` that calls `root.render(element)` inside `act`.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit packages/ui`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`packages/ui/src/feedback.ts`:

```ts
import { useEffect, useRef, useState } from "react";

export type FeedbackPhase = "idle" | "quiet" | "disabled" | "spinner" | "stage";

const LOCAL_MARKS = [100, 1000, 3000] as const;
const REMOTE_MARKS = [200, 3000] as const;
const PERFORMANCE_CLOCK = { now: () => performance.now() };

/**
 * DESIGN.md §7.3 (Orca STYLEGUIDE UX rule 1). Local: nothing under 100 ms, disabled to 1 s, spinner to 3 s, then a
 * stage label. Remote: disabled at once, spinner after about 200 ms, stage label after 3 s. `elapsedMs` is null when
 * nothing is pending.
 */
export function feedbackPhase(elapsedMs: number | null, remote: boolean): FeedbackPhase {
  if (elapsedMs === null) return "idle";
  if (elapsedMs >= 3000) return "stage";
  if (remote) return elapsedMs >= 200 ? "spinner" : "disabled";
  if (elapsedMs >= 1000) return "spinner";
  return elapsedMs >= 100 ? "disabled" : "quiet";
}

/**
 * The phase of an action that started at `since` (a clock reading taken in the event handler), or idle. No state is
 * set during render or synchronously in the effect: timers at the phase boundaries move a clock reading forward.
 */
export function usePendingFeedback(
  since: number | null,
  { remote = true, clock = PERFORMANCE_CLOCK }: { remote?: boolean; clock?: { now(): number } } = {},
): FeedbackPhase {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const timers = (remote ? REMOTE_MARKS : LOCAL_MARKS).map((mark) =>
      window.setTimeout(() => setNow(clock.now()), Math.max(0, since + mark - clock.now())),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [since, remote, clock]);
  return feedbackPhase(since === null ? null : Math.max(0, now - since), remote);
}

/**
 * Runs one action at a time (Orca useImmediateMutation's in-flight guard) and exposes when it started, for a
 * Button's `pendingSince`. A second call while one runs is ignored.
 */
export function usePendingAction(clock: { now(): number } = PERFORMANCE_CLOCK): {
  since: number | null;
  run<T>(action: () => Promise<T>): Promise<T | undefined>;
} {
  const [since, setSince] = useState<number | null>(null);
  const inFlight = useRef(false);
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setSince(clock.now());
    try {
      return await action();
    } finally {
      inFlight.current = false;
      setSince(null);
    }
  };
  return { since, run };
}
```

`packages/ui/src/format.ts`:

```ts
/** DESIGN.md §11: costs as $0.00 (the caller labels provider cost or API-equivalent). */
export function formatCost(usd: number): string {
  const value = Number.isFinite(usd) ? usd : 0;
  return `$${Math.max(0, Math.round(value * 100) / 100).toFixed(2)}`;
}

/** DESIGN.md §11: 00:07 under a minute, 3m40 under an hour, 1h05 above. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (total < 60) return `00:${String(total).padStart(2, "0")}`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, "0")}` : `${minutes}m${String(total % 60).padStart(2, "0")}`;
}

/** DESIGN.md §11: +214 −38, with U+2212 for the minus. */
export function formatDiffCounts(added: number, removed: number): string {
  return `+${added} −${removed}`;
}
```

`packages/ui/src/icons.ts` (if the pinned lucide-react lacks one of these names, use its current name and keep the `Icon*` alias):

```ts
export type { LucideIcon as IconGlyph } from "lucide-react";
export {
  ArrowLeft as IconBack,
  Bot as IconAgents,
  Briefcase as IconWork,
  Check as IconCheck,
  ChevronDown as IconChevronDown,
  ChevronLeft as IconChevronLeft,
  ChevronRight as IconChevronRight,
  Circle as IconDot,
  Columns2 as IconSplit,
  Copy as IconCopy,
  Download as IconExport,
  Ellipsis as IconMore,
  Hourglass as IconHourglass,
  Inbox as IconInbox,
  Keyboard as IconKeyboard,
  Languages as IconLanguage,
  List as IconLists,
  LoaderCircle as IconSpinner,
  LogOut as IconSignOut,
  Palette as IconAppearance,
  PanelLeft as IconTree,
  Plus as IconPlus,
  RotateCcw as IconUndo,
  Search as IconSearch,
  Settings as IconSettings,
  TriangleAlert as IconWarning,
  Upload as IconImport,
  User as IconAccount,
  X as IconClose,
} from "lucide-react";
```

`packages/ui/src/primitives/Icon.tsx`:

```tsx
import type { IconGlyph } from "../icons.ts";

export interface IconProps {
  readonly icon: IconGlyph;
  readonly size?: 14 | 16 | 20 | 28;
  /** Only for an icon that carries meaning on its own; decorative otherwise. */
  readonly label?: string;
}

/** DESIGN.md §7.1: lucide at a 1.5 px stroke in currentColor, 16 px by default, 14 px in compact rows. */
export function Icon({ icon: Glyph, size = 16, label }: IconProps) {
  return (
    <Glyph
      data-slot="icon"
      size={size}
      strokeWidth={1.5}
      focusable="false"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
```

`packages/ui/src/primitives/Spinner.tsx`:

```tsx
import { IconSpinner } from "../icons.ts";

/** 1–3 s feedback (DESIGN.md §7.3). It stops turning under reduced motion and still reads as "working". */
export function Spinner({ label }: { readonly label?: string }) {
  return (
    <span data-slot="spinner" role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="inline-flex animate-spin">
      <IconSpinner size={14} strokeWidth={1.5} aria-hidden />
    </span>
  );
}
```

`packages/ui/src/primitives/ProgressBar.tsx`:

```tsx
import { cn } from "../cn.ts";

const TONES = { agent: "bg-agent-fill", you: "bg-you-fill" } as const;

export interface ProgressBarProps {
  /** Null or absent: the thin indeterminate bar of a running tool card (DESIGN.md §9.1). */
  readonly value?: number | null;
  readonly max?: number;
  readonly label: string;
  readonly tone?: keyof typeof TONES;
}

export function ProgressBar({ value = null, max = 100, label, tone = "agent" }: ProgressBarProps) {
  if (value === null) {
    return (
      <div data-slot="progress" role="progressbar" aria-label={label} className="relative h-0.5 w-full overflow-hidden bg-surface-2">
        <div className={cn("absolute inset-y-0 left-0 w-1/3 animate-indeterminate", TONES[tone])} />
      </div>
    );
  }
  const now = Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0;
  const percent = max > 0 ? (now / max) * 100 : 0;
  return (
    <div data-slot="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={now} className="h-0.5 w-full bg-surface-2">
      <div className={cn("h-full", TONES[tone])} style={{ width: `${percent}%` }} />
    </div>
  );
}
```

In `packages/ui/src/utilities.css`, extend both reduced-motion selector lists that stop `.animate-indeterminate` with the same selectors for `.animate-spin` (e.g. `[data-motion="reduced"] .animate-indeterminate, [data-motion="none"] .animate-indeterminate, [data-motion="reduced"] .animate-spin, [data-motion="none"] .animate-spin { animation: none; }`, and the same inside the `prefers-reduced-motion` block).

`packages/ui/src/index.ts`: export `Icon`, `IconProps`, every name of `icons.ts`, `Spinner`, `ProgressBar`, `ProgressBarProps`, `feedbackPhase`, `usePendingFeedback`, `usePendingAction`, `FeedbackPhase`, `formatCost`, `formatDuration`, `formatDiffCounts`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit packages/ui scripts/class-coverage.test.ts apps/web/src/compiler-gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/ui pnpm-lock.yaml
git commit -m "feat(ui): icons, spinner, progress bar, feedback timing and number formats"
```

---

### Task 5: Button, IconButton, Tooltip, Kbd

DESIGN.md §9.1: Button `primary` (you fill), `secondary` (outline), `ghost`, `danger` (error outline, irreversible actions only; Cancel is never `danger`), labels in mono uppercase; IconButton square with a mandatory label and tooltip. Tooltip follows Orca's STYLEGUIDE: one provider with a 400 ms delay, a tooltip names a control and never teaches, shortcut chips are separate `Kbd` elements, never baked into the label (Orca `components/ShortcutKeyCombo.tsx`).

**Files:**
- Modify: `packages/ui/src/primitives/Button.tsx`, `packages/ui/src/primitives/Button.test.tsx`, `packages/ui/src/index.ts`, `packages/ui/package.json` (`radix-ui`)
- Create: `packages/ui/src/primitives/IconButton.tsx`, `IconButton.test.tsx`, `Tooltip.tsx`, `Kbd.tsx`, `Kbd.test.tsx`
- Modify: `apps/web/src/main.tsx` (wrap the router in `TooltipProvider`)
- Modify: `apps/web/src/features/sessions/SessionScreen.test.tsx` (M2-owned: the two class assertions on the Stop button, M3-RT-05, agreement 5)

**Interfaces:**
- Consumes: `usePendingFeedback`, `Spinner`, `Icon`, `IconGlyph` (Task 4).
- Produces:
  - `Button(props: ButtonProps)`; `ButtonProps` = button attributes without `className`/`style` + `variant?: "primary" | "secondary" | "ghost" | "danger"` (default `secondary`), `size?: "sm" | "md"`, `pendingSince?: number | null`, `remote?: boolean` (default true), `stageLabel?: string`. The M1 props keep working.
  - `IconButton({ icon: IconGlyph; label: string; shortcut?: readonly string[]; shortcutJoiner?: "" | "+"; variant?: "ghost" | "secondary"; size?: "sm" | "md"; ...button attributes without className/style/children/aria-label })`.
  - `TooltipProvider({ children })`, `Tooltip({ label: string; shortcut?: readonly string[]; shortcutJoiner?: "" | "+"; side?: "top" | "right" | "bottom" | "left"; children: ReactElement })`.
  - `Kbd({ keys: readonly string[]; joiner?: "" | "+" })`.

**Rulings (pre-dispatch):**
- Button labels use the HUD label (10.5 px mono, 600, 0.12em): owner M3-Q9 confirmed. [M3R20]
- `sm` is a fixed 24 px row for dense rows; under `pointer: coarse` every button is still 44 × 44 px. [M3R21]
- The secondary button's classes change (`bg-surface`, `border-control-border`), so the M2-owned `SessionScreen.test.tsx` lines 245–246 change in this task: `bg-panel` → `bg-surface`, `border-error` → `border-err`. The file is listed in both plans' conflict tables: at the rebase take M2's version and re-apply these class names wherever its assertions survive (agreement 5). [M3R22]

- [ ] **Step 1: Add radix-ui**

Run: `pnpm --filter @pap/ui add -E radix-ui`

- [ ] **Step 2: Write the failing tests**

Replace `packages/ui/src/primitives/Button.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { Button } from "./Button.tsx";

describe("Button (DESIGN.md §9.1)", () => {
  it("is a plain button unless told otherwise", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('type="button"');
    expect(renderToStaticMarkup(<Button type="submit">Save</Button>)).toContain('type="submit"');
  });

  it("fills primary with the you colour and its own ink", () => {
    const html = renderToStaticMarkup(<Button variant="primary">Send</Button>);
    expect(html).toContain("bg-you-fill");
    expect(html).toContain("text-you-ink");
  });

  it("draws danger as an error outline and ghost without a border colour", () => {
    expect(renderToStaticMarkup(<Button variant="danger">Delete</Button>)).toMatch(/border-err[\s"].*text-err|text-err.*border-err/);
    expect(renderToStaticMarkup(<Button variant="ghost">More</Button>)).toContain("border-transparent");
  });

  it("sets labels as HUD labels, keeps the focus ring and a 44 px target on touch", () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    for (const cls of ["label-hud", "focus-ring", "pointer-coarse:min-h-11", "pointer-coarse:min-w-11", "h-control"]) expect(html).toContain(cls);
  });

  it("keeps the DOM text in sentence case (selectors never depend on CSS text-transform, R121)", () => {
    expect(renderToStaticMarkup(<Button>Allow once</Button>)).toContain(">Allow once<");
  });
});

describe("Button pending feedback (DESIGN.md §7.3)", () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("disables a remote action at once, spins after 200 ms and shows the stage label after 3 s", async () => {
    now = 10;
    const page = await mount(<Button pendingSince={10} stageLabel="Preparing worktree…">Create</Button>);
    const button = page.container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(page.container.querySelector('[data-slot="spinner"]')).toBeNull();
    await act(async () => {
      now = 210;
      vi.advanceTimersByTime(200);
    });
    expect(page.container.querySelector('[data-slot="spinner"]')).not.toBeNull();
    await act(async () => {
      now = 3010;
      vi.advanceTimersByTime(2800);
    });
    expect(button.textContent).toBe("Preparing worktree…");
    await page.unmount();
  });
});
```

`packages/ui/src/primitives/IconButton.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconSettings } from "../icons.ts";
import { IconButton } from "./IconButton.tsx";
import { TooltipProvider } from "./Tooltip.tsx";

describe("IconButton", () => {
  it("names itself with its label and never uses the native title", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <IconButton icon={IconSettings} label="Settings" />
      </TooltipProvider>,
    );
    expect(html).toContain('aria-label="Settings"');
    expect(html).not.toContain("title=");
    expect(html).toContain("size-control");
  });
});
```

`packages/ui/src/primitives/Kbd.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Kbd } from "./Kbd.tsx";

describe("Kbd", () => {
  it("joins mac glyphs with nothing and other platforms with +", () => {
    expect(renderToStaticMarkup(<Kbd keys={["⌘", "K"]} />)).toBe(
      '<kbd data-slot="kbd" class="inline-flex items-center gap-0.5"><kbd class="rounded-sm border border-border-strong bg-surface px-1 font-mono text-label text-muted">⌘</kbd><kbd class="rounded-sm border border-border-strong bg-surface px-1 font-mono text-label text-muted">K</kbd></kbd>',
    );
    expect(renderToStaticMarkup(<Kbd keys={["Ctrl", "K"]} joiner="+" />)).toContain("</kbd>+<kbd");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/primitives`
Expected: FAIL.

- [ ] **Step 4: Implement**

`packages/ui/src/primitives/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn.ts";
import { usePendingFeedback } from "../feedback.ts";
import { Spinner } from "./Spinner.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BASE_CLASSES =
  "inline-flex shrink-0 items-center justify-center gap-s1 whitespace-nowrap rounded-sm border label-hud select-none transition-colors duration-fast focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-you-fill bg-you-fill text-you-ink can-hover:hover:opacity-90",
  secondary: "border-control-border bg-surface text-fg can-hover:hover:bg-surface-2",
  ghost: "border-transparent bg-transparent text-fg can-hover:hover:bg-surface-2",
  // Irreversible actions only. Cancel, Stop and Deny are never danger (DESIGN.md §9.1, R21).
  danger: "border-err bg-transparent text-err can-hover:hover:bg-surface-2",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-6 px-s2",
  md: "h-control px-s3",
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** When the action started (a performance.now() reading from the handler), null when idle. */
  readonly pendingSince?: number | null;
  /** Remote actions disable at once and spin after about 200 ms (default). */
  readonly remote?: boolean;
  /** Replaces the label after 3 s ("Preparing worktree…"). */
  readonly stageLabel?: string;
}

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  pendingSince = null,
  remote = true,
  stageLabel,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const phase = usePendingFeedback(pendingSince, { remote });
  const busy = phase === "disabled" || phase === "spinner" || phase === "stage";
  return (
    <button
      type={type}
      data-slot="button"
      data-variant={variant}
      aria-busy={busy || undefined}
      disabled={disabled === true || busy}
      className={cn(BASE_CLASSES, BUTTON_VARIANTS[variant], BUTTON_SIZES[size])}
      {...rest}
    >
      {phase === "spinner" || phase === "stage" ? <Spinner /> : null}
      {phase === "stage" && stageLabel ? stageLabel : children}
    </button>
  );
}
```

`packages/ui/src/primitives/Kbd.tsx`:

```tsx
import { Fragment } from "react";

const KEY_CLASSES = "rounded-sm border border-border-strong bg-surface px-1 font-mono text-label text-muted";

/** A shortcut chip (Orca ShortcutKeyCombo). The caller formats the keys for the platform (Task 16a `chordTokens`). */
export function Kbd({ keys, joiner = "" }: { readonly keys: readonly string[]; readonly joiner?: "" | "+" }) {
  return (
    <kbd data-slot="kbd" className="inline-flex items-center gap-0.5">
      {keys.map((key, index) => (
        <Fragment key={`${index}:${key}`}>
          {index > 0 && joiner ? joiner : null}
          <kbd className={KEY_CLASSES}>{key}</kbd>
        </Fragment>
      ))}
    </kbd>
  );
}
```

`packages/ui/src/primitives/Tooltip.tsx`:

```tsx
import { Tooltip as Radix } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { Kbd } from "./Kbd.tsx";

/** One provider at the app root (Orca STYLEGUIDE: delayDuration 400). */
export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return (
    <Radix.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </Radix.Provider>
  );
}

export interface TooltipProps {
  /** Names the control. A tooltip never teaches or warns (Orca STYLEGUIDE). */
  readonly label: string;
  readonly shortcut?: readonly string[];
  readonly shortcutJoiner?: "" | "+";
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly children: ReactElement;
}

export function Tooltip({ label, shortcut, shortcutJoiner = "", side = "top", children }: TooltipProps) {
  return (
    <Radix.Root>
      <Radix.Trigger asChild>{children}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          side={side}
          sideOffset={4}
          data-slot="tooltip"
          className="z-50 flex items-center gap-s1 rounded-sm border border-border-strong bg-bg-side px-s2 py-s1 text-ui text-fg shadow-overlay animate-overlay-in"
        >
          {label}
          {shortcut && shortcut.length > 0 ? <Kbd keys={shortcut} joiner={shortcutJoiner} /> : null}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
```

`packages/ui/src/primitives/IconButton.tsx`:

```tsx
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn.ts";
import type { IconGlyph } from "../icons.ts";
import { Icon } from "./Icon.tsx";
import { Tooltip } from "./Tooltip.tsx";

const ICON_BUTTON_BASE_CLASSES =
  "relative inline-flex shrink-0 items-center justify-center rounded-sm border transition-colors duration-fast focus-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:cursor-not-allowed disabled:opacity-50";
const ICON_BUTTON_VARIANTS = {
  ghost: "border-transparent bg-transparent text-muted can-hover:hover:bg-surface-2 can-hover:hover:text-fg",
  secondary: "border-control-border bg-surface text-fg can-hover:hover:bg-surface-2",
} as const;
const ICON_BUTTON_SIZES = { sm: "size-6", md: "size-control" } as const;

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "children" | "aria-label" | "title"> {
  readonly icon: IconGlyph;
  /** Mandatory: the accessible name and the tooltip (DESIGN.md §7.1). */
  readonly label: string;
  readonly shortcut?: readonly string[];
  readonly shortcutJoiner?: "" | "+";
  readonly variant?: keyof typeof ICON_BUTTON_VARIANTS;
  readonly size?: keyof typeof ICON_BUTTON_SIZES;
}

export function IconButton({ icon, label, shortcut, shortcutJoiner, variant = "ghost", size = "md", type = "button", ...rest }: IconButtonProps) {
  return (
    <Tooltip label={label} shortcut={shortcut} shortcutJoiner={shortcutJoiner}>
      <button
        type={type}
        data-slot="icon-button"
        aria-label={label}
        className={cn(ICON_BUTTON_BASE_CLASSES, ICON_BUTTON_VARIANTS[variant], ICON_BUTTON_SIZES[size])}
        {...rest}
      >
        <Icon icon={icon} size={size === "sm" ? 14 : 16} />
      </button>
    </Tooltip>
  );
}
```

`apps/web/src/main.tsx`: wrap `<RouterProvider router={router} />` in `<TooltipProvider>` (import from `@pap/ui`).

`apps/web/src/features/sessions/SessionScreen.test.tsx` ("offers Stop only while running, as a secondary button"): `expect(stop.className).toContain("bg-panel")` becomes `toContain("bg-surface")` and `expect(stop.className).not.toContain("border-error")` becomes `not.toContain("border-err")` (the danger outline is now `border-err`; the old assertion would pass whatever the variant). Nothing else in M2's folder changes.

`packages/ui/src/index.ts`: export `Button`, `ButtonProps`, `ButtonVariant`, `ButtonSize`, `IconButton`, `IconButtonProps`, `Tooltip`, `TooltipProvider`, `TooltipProps`, `Kbd`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit packages/ui apps/web scripts/class-coverage.test.ts`
Expected: PASS, including the M1 web tests that click buttons by their text (the DOM text is unchanged) and `SessionScreen.test.tsx` with its two updated assertions. Mutation check: add `border-err` to `BUTTON_VARIANTS.secondary` once → the updated `SessionScreen.test.tsx` assertion fails; restore.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/ui apps/web/src/main.tsx apps/web/src/features/sessions/SessionScreen.test.tsx pnpm-lock.yaml
git commit -m "feat(ui): button variants with pending feedback, icon button, tooltip and kbd"
```

---

### Task 6: Form controls — TextField, Select, Switch, Checkbox, Slider, Segmented

DESIGN.md §9.1: inputs with a 1 px control border on the `bg` fill and the focus ring; Segmented items in mono uppercase with an agent underline; Switch and Checkbox square; Slider a 2 px track with a square thumb. D19: on coarse pointers, text inputs use 16 px so iOS Safari does not zoom (T3 `index.css:131` `--font-size-prompt-touch: max(…, 16px)`). The submit shortcut ignores the Enter that ends a Safari composition (keyCode 229).

**Files:**
- Modify: `packages/ui/src/primitives/TextField.tsx`, `TextField.test.tsx`, `submit-shortcut.ts`, `submit-shortcut.test.ts`, `packages/ui/src/index.ts`
- Create: `packages/ui/src/primitives/composition.ts`, `Select.tsx`, `Switch.tsx`, `Checkbox.tsx`, `Slider.tsx`, `Segmented.tsx`, `controls.test.tsx`

**Interfaces:**
- Consumes: Task 5 conventions.
- Produces:
  - `cancelsComposition(event: { readonly isComposing?: boolean; readonly keyCode?: number }): boolean` (also used by Tasks 8 and 16).
  - `TextField` (M1 props unchanged).
  - `type Option<V extends string> = { readonly value: V; readonly label: string }`.
  - `Select<V>({ label; value: V; options: readonly Option<V>[]; onChange(value: V): void; hint?; disabled? })`.
  - `Switch({ label; checked; onChange(checked: boolean): void; hint?; disabled? })`.
  - `Checkbox({ label; checked; onChange(checked: boolean): void; disabled? })`.
  - `Slider({ label; value; min; max; step?; onChange(value: number): void; valueText(value: number): string })`.
  - `Segmented<V>({ label; value: V; options: readonly Option<V>[]; onChange(value: V): void })`.

**Rulings (pre-dispatch):**
- On coarse pointers, text inputs use 16 px so iOS does not zoom, above the compact density's 13 px (D19, T3; owner M3-Q9 confirmed). [M3R23]
- Radix ToggleGroup's item role may differ in the pinned version (`radio` or `aria-pressed` buttons): the test's selector follows it and keeps its assertions; which one applies is discovered during implementation. [M3R24]
- Inputs and controls draw their border with `border-control-border` (ADR 0012), never the hairline `border`. [M3R2]

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui/src/primitives/submit-shortcut.test.ts`:

```ts
  it("ignores the Enter that ends a Safari composition (keyCode 229)", () => {
    expect(isSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false, nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(false);
  });
```

(and give the existing calls `keyCode: 13` in `nativeEvent`).

In `packages/ui/src/primitives/TextField.test.tsx`, the M1 case "labels the input and keeps the label an uppercase mono HUD label" asserts `tracking-label` and `uppercase`, which the label no longer carries: replace those two expectations with `expect(html).toContain("label-hud")` (the utility holds the mono face, the tracking and `text-transform: var(--label-transform)`, pinned by `token-classes.test.ts`). Then append:

```ts
  it("uses 16 px text on coarse pointers so iOS does not zoom", () => {
    expect(renderToStaticMarkup(<TextField label="Name" value="" onChange={() => {}} />)).toContain("pointer-coarse:text-base");
  });
```

`packages/ui/src/primitives/controls.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { click, mount } from "../testing/dom.ts";
import { cancelsComposition } from "./composition.ts";
import { Checkbox } from "./Checkbox.tsx";
import { Segmented } from "./Segmented.tsx";
import { Select } from "./Select.tsx";
import { Slider } from "./Slider.tsx";
import { Switch } from "./Switch.tsx";

const DENSITY = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
] as const;

describe("cancelsComposition", () => {
  it("is true while composing and for Safari's keyCode 229", () => {
    expect([cancelsComposition({ isComposing: true }), cancelsComposition({ keyCode: 229 }), cancelsComposition({ keyCode: 27 })]).toEqual([true, true, false]);
  });
});

describe("form controls", () => {
  it("Switch is a labelled square switch that reports the new state", async () => {
    const onChange = vi.fn();
    const page = await mount(<Switch label="Background grid" checked={false} onChange={onChange} />);
    const control = page.container.querySelector('[role="switch"]') as HTMLElement;
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.getAttribute("aria-labelledby")).toBeTruthy();
    await click(control);
    expect(onChange).toHaveBeenCalledWith(true);
    await page.unmount();
  });

  it("Checkbox reports the new state", async () => {
    const onChange = vi.fn();
    const page = await mount(<Checkbox label="Seen" checked onChange={onChange} />);
    await click(page.container.querySelector('[role="checkbox"]') as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(false);
    await page.unmount();
  });

  it("Segmented selects one value and never none", async () => {
    const onChange = vi.fn();
    const page = await mount(<Segmented label="Density" value="compact" options={DENSITY} onChange={onChange} />);
    const items = [...page.container.querySelectorAll('[role="radio"]')] as HTMLElement[];
    expect(items.map((item) => item.textContent)).toEqual(["Compact", "Comfortable"]);
    await click(items[1] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith("comfortable");
    await click(items[0] as HTMLElement);
    expect(onChange).not.toHaveBeenCalledWith("");
    await page.unmount();
  });

  it("Select shows the chosen option and is labelled", async () => {
    const page = await mount(<Select label="Density" value="comfortable" options={DENSITY} onChange={() => {}} />);
    const trigger = page.container.querySelector('[role="combobox"]') as HTMLElement;
    expect(trigger.textContent).toContain("Comfortable");
    const labelId = trigger.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelId.split(" ")[0] ?? "")?.textContent).toBe("Density");
    await page.unmount();
  });

  it("Slider exposes a value text", async () => {
    const page = await mount(<Slider label="Chat size" value={14} min={13} max={18} onChange={() => {}} valueText={(v) => `${v} px`} />);
    expect(page.container.querySelector('[role="slider"]')?.getAttribute("aria-valuetext")).toBe("14 px");
    await page.unmount();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/primitives`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/ui/src/primitives/composition.ts`:

```ts
/**
 * A key that belongs to an input method's composition: `isComposing` in Chrome and Firefox, keyCode 229 in Safari,
 * which reports the composition's last key with it (pw: lib/stacked-dialog.ts). Such a key is never a shortcut,
 * never a submit and never closes a dialog.
 */
export function cancelsComposition(event: { readonly isComposing?: boolean; readonly keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
```

`submit-shortcut.ts`: `nativeEvent: { readonly isComposing: boolean; readonly keyCode?: number }` and `return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !cancelsComposition(event.nativeEvent);`

`TextField.tsx`: the `FIELD` class list becomes

```ts
const FIELD_CLASSES = cn(
  "w-full rounded-sm border border-control-border bg-bg px-s2 py-s1 font-sans text-fg focus-ring pointer-coarse:min-h-11 pointer-coarse:text-base",
  "disabled:cursor-not-allowed disabled:opacity-50",
);
```

with `text-ui` added on the `<input>` and `text-chat` on the `<textarea>` (`cn(FIELD_CLASSES, "h-control text-ui")` / `cn(FIELD_CLASSES, "text-chat")`), the label `className="label-hud text-muted"`, the hint `text-ui text-muted`, the error `text-ui text-attn`. Everything else stays (M1 behaviour and tests).

Shared label markup for the new controls: `<span id={labelId} className="label-hud text-muted">{label}</span>`.

`packages/ui/src/primitives/Switch.tsx`:

```tsx
import { Switch as Radix } from "radix-ui";
import { useId } from "react";

export interface SwitchProps {
  readonly label: string;
  readonly checked: boolean;
  onChange(checked: boolean): void;
  readonly hint?: string;
  readonly disabled?: boolean;
}

/** Square, no pill (DESIGN.md §9.1). */
export function Switch({ label, checked, onChange, hint, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div data-slot="switch" className="flex items-center justify-between gap-s3">
      <div className="flex flex-col gap-s1">
        <span id={`${id}-label`} className="text-ui text-fg">
          {label}
        </span>
        {hint ? (
          <span id={`${id}-hint`} className="text-ui text-muted">
            {hint}
          </span>
        ) : null}
      </div>
      <Radix.Root
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="relative inline-flex h-4 w-8 shrink-0 items-center rounded-sm border border-control-border bg-surface p-0.5 transition-colors duration-fast focus-ring state-checked:border-agent-fill state-checked:bg-agent-fill disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        <Radix.Thumb className="block size-2.5 rounded-sm bg-fg transition-transform duration-fast state-checked:translate-x-4 state-checked:bg-agent-ink" />
      </Radix.Root>
    </div>
  );
}
```

`Checkbox.tsx`: Radix `Checkbox.Root` (`size-4 rounded-sm border border-control-border bg-bg focus-ring state-checked:bg-agent-fill state-checked:border-agent-fill`, `pointer-coarse:size-11`… keep the visual box 16 px and wrap it in a `label` whose row is `pointer-coarse:min-h-11`) with `Checkbox.Indicator` holding `<Icon icon={IconCheck} size={14} />` in `text-agent-ink`; `onCheckedChange={(state) => onChange(state === true)}`; the label text in a `<label htmlFor>` next to it.

`Segmented.tsx`:

```tsx
import { ToggleGroup } from "radix-ui";
import type { Option } from "./Select.tsx";

const ITEM_CLASSES =
  "h-control border-b-2 border-transparent px-s2 label-hud text-muted transition-colors duration-fast focus-ring can-hover:hover:text-fg state-on:border-agent state-on:text-fg pointer-coarse:min-h-11";

export interface SegmentedProps<V extends string> {
  readonly label: string;
  readonly value: V;
  readonly options: readonly Option<V>[];
  onChange(value: V): void;
}

/** Mono upper-case items; the active one gets an agent underline (DESIGN.md §9.1). One value is always selected. */
export function Segmented<V extends string>({ label, value, options, onChange }: SegmentedProps<V>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(next) => {
        if (next !== "") onChange(next as V);
      }}
      data-slot="segmented"
      className="inline-flex items-center gap-s1 border-b border-border"
    >
      {options.map((option) => (
        <ToggleGroup.Item key={option.value} value={option.value} className={ITEM_CLASSES}>
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
```

Radix ToggleGroup with `type="single"` renders items as `role="radio"` inside `role="group"`… if the pinned version renders `aria-pressed` buttons instead, change the test's selector to `button[aria-pressed]` and keep its assertions.

`Select.tsx`:

```tsx
import { Select as Radix } from "radix-ui";
import { useId } from "react";
import { IconCheck, IconChevronDown } from "../icons.ts";
import { Icon } from "./Icon.tsx";

export interface Option<V extends string> {
  readonly value: V;
  readonly label: string;
}

export interface SelectProps<V extends string> {
  readonly label: string;
  readonly value: V;
  readonly options: readonly Option<V>[];
  onChange(value: V): void;
  readonly hint?: string;
  readonly disabled?: boolean;
}

const TRIGGER_CLASSES =
  "inline-flex h-control w-full items-center justify-between gap-s2 rounded-sm border border-control-border bg-bg px-s2 text-ui text-fg focus-ring disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:text-base";
const ITEM_CLASSES =
  "relative flex h-control cursor-default select-none items-center gap-s2 rounded-sm px-s2 text-ui text-fg outline-none data-highlighted:bg-surface-2 pointer-coarse:min-h-11";

export function Select<V extends string>({ label, value, options, onChange, hint, disabled }: SelectProps<V>) {
  const id = useId();
  return (
    <div data-slot="select" className="flex flex-col gap-s1">
      <span id={`${id}-label`} className="label-hud text-muted">
        {label}
      </span>
      <Radix.Root value={value} onValueChange={(next) => onChange(next as V)} disabled={disabled}>
        <Radix.Trigger aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined} className={TRIGGER_CLASSES}>
          <Radix.Value />
          <Radix.Icon>
            <Icon icon={IconChevronDown} size={14} />
          </Radix.Icon>
        </Radix.Trigger>
        <Radix.Portal>
          <Radix.Content position="popper" sideOffset={4} className="z-50 min-w-40 rounded-md border border-border-strong bg-bg-side p-s1 shadow-overlay animate-overlay-in">
            <Radix.Viewport>
              {options.map((option) => (
                <Radix.Item key={option.value} value={option.value} className={ITEM_CLASSES}>
                  <Radix.ItemText>{option.label}</Radix.ItemText>
                  <Radix.ItemIndicator className="ml-auto text-agent">
                    <Icon icon={IconCheck} size={14} />
                  </Radix.ItemIndicator>
                </Radix.Item>
              ))}
            </Radix.Viewport>
          </Radix.Content>
        </Radix.Portal>
      </Radix.Root>
      {hint ? (
        <span id={`${id}-hint`} className="text-ui text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
```

`Slider.tsx`: Radix `Slider.Root` (`relative flex h-5 w-full touch-none select-none items-center pointer-coarse:h-11`), `Slider.Track` (`relative h-0.5 grow bg-surface-2`), `Slider.Range` (`absolute h-full bg-agent-fill`), `Slider.Thumb` (`block size-3 rounded-sm border border-agent-fill bg-bg focus-ring`, `aria-valuetext={valueText(value)}`, `aria-labelledby` the label id); `value={[value]}`, `onValueChange={([next]) => next !== undefined && onChange(next)}`; label row shows the label and `valueText(value)` in `font-mono tabular-nums text-muted`.

`packages/ui/src/index.ts`: export `cancelsComposition`, `Select`, `SelectProps`, `Option`, `Switch`, `SwitchProps`, `Checkbox`, `Slider`, `Segmented`, `SegmentedProps`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit packages/ui apps/web scripts/class-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/ui
git commit -m "feat(ui): form controls with the iOS 16 px rule and Safari composition guard"
```

---

### Task 7: Status and structure — Chip, Badge, Avatar, Meter, Banner, EmptyState, OpenTab, Collapsible

DESIGN.md §9.1 rows for these components, plus §2 ("every status chip carries a word"; dashed versus solid is a cue independent of colour). Collapsible is missing from DESIGN §9.1 and Reasoning and ToolCard need it (S6, R53): ADR 0010 adds it (M2 holds ADRs 0006–0009, agreement 2).

**Files:**
- Create: `packages/ui/src/primitives/Chip.tsx`, `Badge.tsx`, `Avatar.tsx`, `Meter.tsx`, `Banner.tsx`, `EmptyState.tsx`, `OpenTab.tsx`, `Collapsible.tsx`, `display.test.tsx`
- Modify: `packages/ui/src/primitives/IconButton.tsx` (optional `badge`), `packages/ui/src/index.ts`
- Create: `docs/adr/0010-collapsible-primitive.md`

**Interfaces:**
- Produces:
  - `type ChipTone = "run" | "ok" | "att" | "err" | "mut" | "ext"`, `Chip({ tone: ChipTone; label: string; dot?: boolean })`.
  - `Badge({ count: number; label: string })` (renders `99+` above 99; `label` is the accessible text, e.g. "3 unread").
  - `type AvatarStyle = "outlined" | "tinted" | "glyph"`, `Avatar({ initials: string; name: string; avatarStyle?: AvatarStyle; presence?: "running" | "waiting" | "idle"; badge?: { count: number; label: string } })`.
  - `Meter({ label: string; value: number; max: number; kind: "tokens" | "cost"; valueText: string })`.
  - `type BannerTone = "crash" | "capacity" | "offline" | "checkpoint"`, `Banner({ tone; title: string; children?: ReactNode; actions?: ReactNode })`.
  - `EmptyState({ title: string; purpose: string; action?: ReactNode })`.
  - `OpenTab({ title: string; active: boolean; status?: "running" | "waiting" | null; onSelect(): void; onClose(): void; closeLabel: string; tabId: string; panelId?: string })`.
  - `Collapsible({ open; onOpenChange(open: boolean): void; trigger: ReactNode; children: ReactNode })` built on Radix Collapsible (`trigger` is the trigger's content; the trigger is a button that owns its look).
  - `IconButton` gains `badge?: { count: number; label: string }`.

**Rulings (pre-dispatch):**
- OpenTab puts its close button next to the `role="tab"` button (`tabIndex=-1`); the keyboard closes a focused tab with Delete (WAI-ARIA tabs pattern) and anywhere with the `tab.close` command (Tasks 16b and 21). [M3R25]
- Meter and ProgressBar report a value clamped to their range. [M3R19]
- Collapsible is ADR 0010; `/dev/ui` is ADR 0011; R120 is ADR 0012 (agreement 2). [M3R26]

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/primitives/display.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mount, press } from "../testing/dom.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Banner } from "./Banner.tsx";
import { Chip } from "./Chip.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Meter } from "./Meter.tsx";
import { OpenTab } from "./OpenTab.tsx";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("status and structure (DESIGN.md §9.1, §2)", () => {
  it("chips always carry a word; external content is dashed attention", () => {
    expect(html(<Chip tone="run" label="Working" />)).toContain(">Working<");
    expect(html(<Chip tone="ext" label="External content" />)).toMatch(/border-dashed[^"]*border-attn|border-attn[^"]*border-dashed/);
    expect(html(<Chip tone="att" label="Needs input" dot />)).toContain('data-slot="chip-dot"');
  });

  it("badges are round attention fills, capped at 99+, with an accessible label", () => {
    const badge = html(<Badge count={120} label="120 unread" />);
    expect(badge).toContain(">99+<");
    expect(badge).toContain("rounded-full");
    expect(badge).toContain("bg-attn-fill");
    expect(badge).toContain("120 unread");
  });

  it("avatars are outlined initials by default and can show presence and a count", () => {
    const avatar = html(<Avatar initials="AT" name="Atlas" presence="waiting" badge={{ count: 2, label: "2 unread" }} />);
    expect(avatar).toContain("border-agent");
    expect(avatar).toContain('data-presence="waiting"');
    expect(html(<Avatar initials="AT" name="Atlas" avatarStyle="glyph" />)).toContain("bg-agent-fill");
  });

  it("meters use agent for tokens and you for cost", () => {
    expect(html(<Meter label="Tokens today" value={10} max={100} kind="tokens" valueText="10k" />)).toContain("bg-agent-fill");
    expect(html(<Meter label="Cost today" value={1} max={4} kind="cost" valueText="$1.00" />)).toContain("bg-you-fill");
  });

  it("banners: crash is an alert in error, offline is dashed, checkpoint is you tint", () => {
    expect(html(<Banner tone="crash" title="Agent process killed" />)).toContain('role="alert"');
    expect(html(<Banner tone="offline" title="Reconnecting…" />)).toContain("border-dashed");
    expect(html(<Banner tone="checkpoint" title="Files differ from this point" />)).toContain("bg-you-tint");
  });

  it("an empty state is a dashed frame with one purpose and one action", () => {
    const empty = html(<EmptyState title="No agent yet" purpose="An agent has its own thread." action={<button type="button">Create</button>} />);
    expect(empty).toContain("border-dashed");
    expect(empty).toContain("<h2");
  });

  it("an open tab is a tab with an agent border when active and a labelled close button", () => {
    const tab = html(<OpenTab tabId="t1" title="feat/checkpoints" active status="running" closeLabel="Close feat/checkpoints" onSelect={() => {}} onClose={() => {}} />);
    expect(tab).toContain('role="tab"');
    expect(tab).toContain('aria-selected="true"');
    expect(tab).toContain("border-agent");
    expect(tab).toContain('aria-label="Close feat/checkpoints"');
  });

  it("closes a focused tab with Delete, and only with Delete (WAI-ARIA tabs pattern)", async () => {
    const onClose = vi.fn();
    const page = await mount(<OpenTab tabId="t2" title="a" active closeLabel="Close a" onSelect={() => {}} onClose={onClose} />);
    const tab = page.container.querySelector('[role="tab"]') as HTMLElement;
    await press(tab, { key: "Enter" });
    await press(tab, { key: "Delete" });
    expect(onClose).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("meters report a value clamped to their range", () => {
    expect(html(<Meter label="Cost today" value={9} max={4} kind="cost" valueText="$9.00" />)).toContain('aria-valuenow="4"');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/primitives/display.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`Chip.tsx`:

```tsx
import { cn } from "../cn.ts";

export type ChipTone = "run" | "ok" | "att" | "err" | "mut" | "ext";

const CHIP_TONES: Record<ChipTone, string> = {
  run: "border-agent text-agent",
  ok: "border-ok text-ok",
  att: "border-attn text-attn",
  err: "border-err text-err",
  mut: "border-border-strong text-muted",
  ext: "border-dashed border-attn text-attn",
};

/** Status chip: a mono upper-case word, optional dot; the word is what screen readers read (DESIGN.md §12). */
export function Chip({ tone, label, dot = false }: { readonly tone: ChipTone; readonly label: string; readonly dot?: boolean }) {
  return (
    <span data-slot="chip" data-tone={tone} className={cn("inline-flex h-4.5 items-center gap-1 rounded-sm border px-1 label-hud", CHIP_TONES[tone])}>
      {dot ? <span data-slot="chip-dot" aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {label}
    </span>
  );
}
```

`Badge.tsx`:

```tsx
export function Badge({ count, label }: { readonly count: number; readonly label: string }) {
  return (
    <span data-slot="badge" className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-attn-fill px-1 font-mono text-label font-bold tabular-nums text-attn-ink">
      <span aria-hidden>{count > 99 ? "99+" : count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
```

`Avatar.tsx`:

```tsx
import { cn } from "../cn.ts";
import { Badge } from "./Badge.tsx";

export type AvatarStyle = "outlined" | "tinted" | "glyph";

const AVATAR_STYLE: Record<AvatarStyle, string> = {
  outlined: "border-agent text-agent",
  tinted: "border-agent bg-agent/10 text-agent",
  glyph: "border-agent-fill bg-agent-fill text-agent-ink",
};
const PRESENCE_TONES = { running: "bg-agent-fill", waiting: "bg-attn-fill", idle: "bg-dim" } as const;

export interface AvatarProps {
  readonly initials: string;
  readonly name: string;
  readonly avatarStyle?: AvatarStyle;
  readonly presence?: keyof typeof PRESENCE_TONES;
  readonly badge?: { readonly count: number; readonly label: string };
}

/** Agent avatar (DESIGN.md §9.1): outlined initials by default, presence dot, count badge. */
export function Avatar({ initials, name, avatarStyle = "outlined", presence, badge }: AvatarProps) {
  return (
    <span data-slot="avatar" data-presence={presence} role="img" aria-label={name} className={cn("relative inline-flex size-avatar shrink-0 items-center justify-center rounded-md border font-sans text-label font-bold", AVATAR_STYLE[avatarStyle])}>
      <span aria-hidden>{initials.slice(0, 2)}</span>
      {presence ? <span aria-hidden className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full border border-bg", PRESENCE_TONES[presence])} /> : null}
      {badge && badge.count > 0 ? (
        <span className="absolute -right-1.5 -top-1.5">
          <Badge count={badge.count} label={badge.label} />
        </span>
      ) : null}
    </span>
  );
}
```

`Meter.tsx`: a row with the label (`label-hud text-muted`) and `valueText` (`font-mono tabular-nums text-fg`), then a `role="meter"` bar (`h-1 w-full bg-surface-2`) with `aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(max, Math.max(0, value))} aria-valuetext={valueText} aria-label={label}` (non-finite values read as 0) whose fill uses `const METER_TONES = { tokens: "bg-agent-fill", cost: "bg-you-fill" } as const` and an inline `width` clamped to 0–100 %.

`Banner.tsx`:

```tsx
import type { ReactNode } from "react";
import { cn } from "../cn.ts";

export type BannerTone = "crash" | "capacity" | "offline" | "checkpoint";

const BANNER_TONES: Record<BannerTone, { readonly frame: string; readonly title: string }> = {
  crash: { frame: "border-err bg-surface", title: "text-err" },
  capacity: { frame: "border-border-strong bg-surface", title: "text-fg" },
  offline: { frame: "border-dashed border-border-strong bg-surface", title: "text-muted" },
  checkpoint: { frame: "border-you-line bg-you-tint", title: "text-you-text" },
};

export interface BannerProps {
  readonly tone: BannerTone;
  readonly title: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}

/** DESIGN.md §9.1 and §11: say what happened, what is intact, what you can do. Crash is an alert, the rest status. */
export function Banner({ tone, title, children, actions }: BannerProps) {
  const style = BANNER_TONES[tone];
  return (
    <section data-slot="banner" data-tone={tone} role={tone === "crash" ? "alert" : "status"} className={cn("flex flex-wrap items-start justify-between gap-s2 rounded-md border px-s3 py-s2", style.frame)}>
      <div className="flex min-w-0 flex-col gap-s1">
        <p className={cn("text-ui font-semibold", style.title)}>{title}</p>
        {children ? <div className="text-ui text-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-s2">{actions}</div> : null}
    </section>
  );
}
```

`EmptyState.tsx`:

```tsx
import type { ReactNode } from "react";

/** DESIGN.md §9.1: dashed frame, one sentence of purpose, one primary action. */
export function EmptyState({ title, purpose, action }: { readonly title: string; readonly purpose: string; readonly action?: ReactNode }) {
  return (
    <section data-slot="empty-state" className="flex flex-col items-start gap-s2 rounded-md border border-dashed border-border-strong p-s5">
      <h2 className="text-h2 text-fg">{title}</h2>
      <p className="text-ui text-muted">{purpose}</p>
      {action ? <div className="mt-s1">{action}</div> : null}
    </section>
  );
}
```

`OpenTab.tsx`:

```tsx
import { cn } from "../cn.ts";
import { IconClose } from "../icons.ts";
import { Icon } from "./Icon.tsx";

const TAB_CLASSES =
  "group inline-flex h-bar max-w-56 shrink-0 items-center gap-s1 rounded-sm border px-s2 label-hud transition-colors duration-fast focus-ring pointer-coarse:min-h-11";
const TAB_STATE = {
  active: "border-agent bg-surface-2 text-fg",
  idle: "border-border text-muted can-hover:hover:text-fg",
} as const;
const STATUS_TONES = { running: "bg-agent-fill", waiting: "bg-attn-fill" } as const;

export interface OpenTabProps {
  readonly tabId: string;
  readonly panelId?: string;
  readonly title: string;
  readonly active: boolean;
  readonly status?: keyof typeof STATUS_TONES | null;
  readonly closeLabel: string;
  onSelect(): void;
  onClose(): void;
}

/** One open item (DESIGN.md §8): mono upper case, agent border and surface-2 fill when active. Closing deletes nothing. */
export function OpenTab({ tabId, panelId, title, active, status = null, closeLabel, onSelect, onClose }: OpenTabProps) {
  return (
    <div data-slot="open-tab" className={cn(TAB_CLASSES, active ? TAB_STATE.active : TAB_STATE.idle)}>
      <button
        type="button"
        role="tab"
        id={tabId}
        aria-selected={active}
        aria-controls={panelId}
        tabIndex={active ? 0 : -1}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key !== "Delete") return;
          event.preventDefault();
          onClose();
        }}
        className="flex min-w-0 items-center gap-s1 outline-none"
      >
        {status ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_TONES[status])} /> : null}
        <span className="truncate">{title}</span>
      </button>
      <button type="button" aria-label={closeLabel} tabIndex={-1} onClick={onClose} className="inline-flex size-4 items-center justify-center rounded-sm text-muted can-hover:hover:bg-surface pointer-coarse:size-11">
        <Icon icon={IconClose} size={14} />
      </button>
    </div>
  );
}
```

`Collapsible.tsx`:

```tsx
import { Collapsible as Radix } from "radix-ui";
import type { ReactNode } from "react";

export interface CollapsibleProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** The trigger's content; the trigger itself is a full-width button that owns its look. */
  readonly trigger: ReactNode;
  readonly children: ReactNode;
}

/** ADR 0010 (S6, R53): the disclosure Reasoning and ToolCard need. */
export function Collapsible({ open, onOpenChange, trigger, children }: CollapsibleProps) {
  return (
    <Radix.Root open={open} onOpenChange={onOpenChange} data-slot="collapsible">
      <Radix.Trigger className="flex w-full items-center gap-s1 rounded-sm text-left focus-ring pointer-coarse:min-h-11">{trigger}</Radix.Trigger>
      <Radix.Content>{children}</Radix.Content>
    </Radix.Root>
  );
}
```

`IconButton.tsx`: add `readonly badge?: { readonly count: number; readonly label: string };` and render `{badge && badge.count > 0 ? <span className="absolute -right-1 -top-1"><Badge count={badge.count} label={badge.label} /></span> : null}` after the icon.

`docs/adr/0010-collapsible-primitive.md`:

```markdown
# ADR 0010 — Collapsible joins the primitives

Status: accepted · Date: 2026-10-11 · Spec: DESIGN.md §9.1 (decision 33: design changes go through an ADR) · Rulings: R53

## Context
DESIGN.md §9.2 needs a disclosure for Reasoning ("▸ thought for 14s", expandable) and for ToolCard's detail levels. §9.1 lists no
primitive for it. Spike S6 (docs/spikes/s6.md, ruling R53) found that every AI Elements component of that kind sits on Radix
Collapsible.

## Decision
`packages/ui` owns a `Collapsible` primitive on Radix Collapsible: a full-width trigger button that owns its look, and a content
region. No animation of the height (state swaps are 0 ms, DESIGN.md §7.2).

## Consequences
Reasoning and ToolCard use it; callers never restyle the trigger. DESIGN.md §9.1's table gains a "Collapsible" row at the next
DESIGN.md revision.
```

`packages/ui/src/index.ts`: export all of the above and their prop types.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit packages/ui scripts/class-coverage.test.ts scripts/literal-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/ui docs/adr/0010-collapsible-primitive.md
git commit -m "feat(ui): chips, badges, avatars, meters, banners, empty states, open tabs and collapsible"
```

---

### Task 8: Overlays — Dialog, Sheet, Drawer, Menu, Toast

Every overlay carries `--shadow-overlay`, traps focus, closes on Escape and returns focus to where it came from (T3 `finalFocus`, Orca `useModalReturnFocus`). Radix's layer stack already closes only the topmost layer (the pi-web `stacked-dialog` rule); our wrappers add the Safari composition guard: an Escape that ends a composition never closes anything. On phones, a centred dialog becomes a bottom sheet (T3 `components/ui/dialog.tsx` `bottomStickOnMobile`) and menus become sheets; a sheet lives inside `--app-viewport-height`, never at `bottom: 0` (pw: docs/agents/client-platform.md — iOS keeps the layout viewport, and `bottom: 0`, under the keyboard). Toasts sit bottom right, bottom on phones, 5 s, with Undo for reversible actions (DESIGN.md §9.1).

**Files:**
- Create: `packages/ui/src/media.ts`, `packages/ui/src/primitives/Dialog.tsx`, `Dialog.test.tsx`, `Menu.tsx`, `Menu.test.tsx`, `Toast.tsx`, `Toast.test.tsx`
- Modify: `packages/ui/src/index.ts`, `apps/web/src/main.tsx` (mount the Toaster through a small `LocalizedToaster` that reads `useT`)

**Interfaces:**
- Consumes: `cancelsComposition` (Task 6), `IconButton` (Task 5).
- Produces:
  - `useMediaQuery(query: string): boolean`, `useIsPhone(): boolean` (`(max-width: 767.98px)`).
  - `type DialogVariant = "center" | "sheet" | "drawer-left" | "drawer-right" | "palette"`.
  - `Dialog({ open; onOpenChange(open: boolean): void; title: string; hideTitle?: boolean; description?: string; variant?: DialogVariant; closeLabel: string; children; footer?: ReactNode; initialFocus?: RefObject<HTMLElement | null> })`. Content carries `data-pap-modal` (the `dialogOpen` key of Task 17a reads it).
  - `type MenuItem = { readonly id: string; readonly label: string; readonly tone?: "danger"; readonly disabled?: boolean; onSelect(): void }`, `Menu({ label: string; trigger: ReactElement; items: readonly MenuItem[]; closeLabel: string })`.
  - `toast(input: { message: string; tone?: "neutral" | "error"; action?: { label: string; altText: string; run(): void } }): string` (returns the toast id), `dismissToast(id: string): void`, `Toaster({ closeLabel: string })`.

**Rulings (pre-dispatch):**
- On phones every centred dialog, the palette and every menu becomes a bottom sheet (T3 `bottomStickOnMobile`; DESIGN §8 "bottom sheets for menus"). [M3R27]
- The 60 % background dim behind modal overlays (`bg-bg/60`) is accepted (owner M3-Q9). [M3R28]
- If Radix's focus return needs a settled frame in happy-dom, the test awaits `settle()` before the assertion; the assertion is never dropped. Whether it is needed is discovered during implementation. [M3R29]
- The toast store is module state: `resetToastsForTests()` (not exported from the package index) clears it between tests, and the app renders the Toaster from a component that reads `useT`, so its close label follows a language switch (R128, M3-RT-26). [M3R30]

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/primitives/Dialog.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { click, mount, press } from "../testing/dom.ts";
import { Dialog } from "./Dialog.tsx";
import { TooltipProvider } from "./Tooltip.tsx";

function Harness() {
  const [open, setOpen] = useState(false);
  // The close button is an IconButton, whose tooltip needs the provider.
  return (
    <TooltipProvider>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Keyboard shortcuts" closeLabel="Close">
        <input aria-label="Filter" />
      </Dialog>
    </TooltipProvider>
  );
}

const dialog = () => document.querySelector('[role="dialog"]');

describe("Dialog", () => {
  it("opens with the overlay shadow and the modal marker, and closes on Escape", async () => {
    const page = await mount(<Harness />);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(dialog()?.getAttribute("data-pap-modal")).not.toBeNull();
    expect(dialog()?.className).toContain("shadow-overlay");
    await press(document.activeElement ?? document.body, { key: "Escape" });
    expect(dialog()).toBeNull();
    await page.unmount();
  });

  it("does not close on the Escape that ends a Safari composition (keyCode 229)", async () => {
    const page = await mount(<Harness />);
    await click(page.container.querySelector("button") as HTMLElement);
    await press(document.activeElement ?? document.body, { key: "Escape", keyCode: 229 });
    expect(dialog()).not.toBeNull();
    await press(document.activeElement ?? document.body, { key: "Escape" });
    await page.unmount();
  });

  it("returns focus to the element that had it", async () => {
    const page = await mount(<Harness />);
    const opener = page.container.querySelector("button") as HTMLButtonElement;
    opener.focus();
    await click(opener);
    await press(document.activeElement ?? document.body, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
    await page.unmount();
  });
});
```

`packages/ui/src/primitives/Toast.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount } from "../testing/dom.ts";
import { resetToastsForTests, toast, Toaster } from "./Toast.tsx";

describe("Toast", () => {
  beforeEach(() => {
    resetToastsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("shows a message with Undo for 5 s; Undo runs once and closes it", async () => {
    const page = await mount(<Toaster closeLabel="Dismiss" />);
    const undo = vi.fn();
    await act(async () => {
      toast({ message: "Appearance reset", action: { label: "Undo", altText: "Undo the reset", run: undo } });
    });
    expect(document.body.textContent).toContain("Appearance reset");
    const undoButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "Undo") as HTMLButtonElement;
    await click(undoButton);
    expect(undo).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(document.body.textContent).not.toContain("Appearance reset");
    await page.unmount();
  });

  it("keeps at most three toasts, dropping the oldest", async () => {
    const page = await mount(<Toaster closeLabel="Dismiss" />);
    await act(async () => {
      for (const n of [1, 2, 3, 4]) toast({ message: `Toast ${n}` });
    });
    const shown = [...document.querySelectorAll('[data-slot="toast"]')].map((t) => t.textContent ?? "");
    expect(shown.map((t) => t.replace("Dismiss", "").trim())).toEqual(["Toast 2", "Toast 3", "Toast 4"]);
    await page.unmount();
  });

  it("closes by itself after 5 s", async () => {
    const page = await mount(<Toaster closeLabel="Dismiss" />);
    await act(async () => {
      toast({ message: "Saved" });
    });
    await act(async () => {
      vi.advanceTimersByTime(5300);
    });
    expect(document.body.textContent).not.toContain("Saved");
    await page.unmount();
  });
});
```

`packages/ui/src/primitives/Menu.test.tsx` (rendered inside `TooltipProvider`): with `window.matchMedia` stubbed to report a phone (`matches: true` for `(max-width: 767.98px)`), clicking the trigger opens a `role="dialog"` sheet listing the items as buttons; clicking one calls its `onSelect` and closes the sheet. With the stub reporting desktop, the trigger has `aria-haspopup="menu"` (Radix DropdownMenu).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/primitives/Dialog.test.tsx packages/ui/src/primitives/Toast.test.tsx packages/ui/src/primitives/Menu.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/ui/src/media.ts`:

```ts
import { useSyncExternalStore } from "react";

/** A media query as React state (T3 hooks/useMediaQuery.ts). False where matchMedia does not exist. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

/** DESIGN.md §8: below 768 px is a phone. */
export const PHONE_QUERY = "(max-width: 767.98px)";
export const useIsPhone = (): boolean => useMediaQuery(PHONE_QUERY);
```

`packages/ui/src/primitives/Dialog.tsx`:

```tsx
import { Dialog as Radix, VisuallyHidden } from "radix-ui";
import { useRef, type ReactNode, type RefObject } from "react";
import { cn } from "../cn.ts";
import { IconClose } from "../icons.ts";
import { useIsPhone } from "../media.ts";
import { cancelsComposition } from "./composition.ts";
import { IconButton } from "./IconButton.tsx";

export type DialogVariant = "center" | "sheet" | "drawer-left" | "drawer-right" | "palette";

const PANEL_CLASSES = "flex flex-col overflow-hidden border border-border-strong bg-bg-side text-fg shadow-overlay animate-overlay-in";
const DIALOG_VARIANTS: Record<DialogVariant, string> = {
  center: "fixed left-1/2 top-1/2 z-50 w-full max-w-lg max-h-app -translate-x-1/2 -translate-y-1/2 rounded-md",
  // pw: the sheet is a layer of the visual viewport's height with the panel at its bottom (iOS keyboard).
  sheet: "fixed inset-x-0 top-0 z-50 flex h-app flex-col justify-end",
  "drawer-left": "fixed inset-y-0 left-0 z-50 h-app w-drawer-tree max-w-full rounded-r-md pl-safe",
  "drawer-right": "fixed inset-y-0 right-0 z-50 h-app w-drawer-inbox max-w-full rounded-l-md pr-safe",
  palette: "fixed left-1/2 top-s6 z-50 w-full max-w-xl max-h-app -translate-x-1/2 rounded-md",
};
const SHEET_PANEL_CLASSES = "max-h-app rounded-t-md border-b-0 pb-safe";

export interface DialogProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  readonly title: string;
  readonly hideTitle?: boolean;
  readonly description?: string;
  readonly variant?: DialogVariant;
  readonly closeLabel: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly initialFocus?: RefObject<HTMLElement | null>;
}

export function Dialog({ open, onOpenChange, title, hideTitle = false, description, variant = "center", closeLabel, children, footer, initialFocus }: DialogProps) {
  const phone = useIsPhone();
  const shown: DialogVariant = phone && (variant === "center" || variant === "palette") ? "sheet" : variant;
  const returnTo = useRef<HTMLElement | null>(null);
  const header = (
    <header className="flex items-center justify-between gap-s2 border-b border-border px-s3 py-s2">
      {hideTitle ? (
        <VisuallyHidden.Root asChild>
          <Radix.Title>{title}</Radix.Title>
        </VisuallyHidden.Root>
      ) : (
        <Radix.Title className="text-h2 text-fg">{title}</Radix.Title>
      )}
      <Radix.Close asChild>
        <IconButton icon={IconClose} label={closeLabel} size="sm" />
      </Radix.Close>
    </header>
  );
  const body = (
    <>
      {header}
      {description ? <Radix.Description className="px-s3 pt-s2 text-ui text-muted">{description}</Radix.Description> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer ? <footer className="flex justify-end gap-s2 border-t border-border px-s3 py-s2">{footer}</footer> : null}
    </>
  );
  return (
    <Radix.Root open={open} onOpenChange={onOpenChange}>
      <Radix.Portal>
        <Radix.Overlay className="fixed inset-0 z-50 bg-bg/60" />
        <Radix.Content
          data-pap-modal=""
          data-slot="dialog"
          data-variant={shown}
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(DIALOG_VARIANTS[shown], shown === "sheet" ? "pointer-events-none" : PANEL_CLASSES)}
          onEscapeKeyDown={(event) => {
            if (cancelsComposition(event)) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            if (initialFocus?.current) {
              event.preventDefault();
              initialFocus.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            const target = returnTo.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          onClick={(event) => {
            // The sheet's layer is transparent above the panel: a tap there closes, like a tap on the overlay.
            if (shown === "sheet" && event.target === event.currentTarget) onOpenChange(false);
          }}
        >
          {shown === "sheet" ? <div className={cn("pointer-events-auto", PANEL_CLASSES, SHEET_PANEL_CLASSES)}>{body}</div> : body}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
```

(Radix warns when a dialog has no `Description`; passing `aria-describedby: undefined` when `description` is absent is how Radix documents silencing it.)

`Menu.tsx`: on desktop, Radix `DropdownMenu` (`Trigger asChild` = `trigger`, `Content` with `PANEL`-like classes `z-50 min-w-48 rounded-md border border-border-strong bg-bg-side p-s1 shadow-overlay animate-overlay-in`, items `flex h-control items-center rounded-sm px-s2 text-ui outline-none data-highlighted:bg-surface-2 pointer-coarse:min-h-11`, `tone: "danger"` → `text-err`); on a phone (`useIsPhone()`), the trigger opens a `Dialog variant="sheet" title={label} closeLabel={closeLabel}` listing each item as a full-width `Button variant="ghost"` that calls `onSelect` then closes. The trigger's `onClick` is attached with `cloneElement` in the phone branch.

`Toast.tsx`:

```tsx
import { Toast as Radix } from "radix-ui";
import { useSyncExternalStore } from "react";
import { cn } from "../cn.ts";
import { IconClose } from "../icons.ts";
import { Icon } from "./Icon.tsx";

export interface ToastInput {
  readonly message: string;
  readonly tone?: "neutral" | "error";
  /** Undo for a reversible action (DESIGN.md §9.1). */
  readonly action?: { readonly label: string; readonly altText: string; run(): void };
}

interface Entry extends ToastInput {
  readonly id: string;
}

const DURATION_MS = 5000;
let entries: readonly Entry[] = [];
let counter = 0;
const listeners = new Set<() => void>();
const emit = (next: readonly Entry[]) => {
  entries = next;
  for (const listener of [...listeners]) listener();
};

export function toast(input: ToastInput): string {
  const id = `t${++counter}`;
  emit([...entries, { ...input, id }].slice(-3));
  return id;
}

export function dismissToast(id: string): void {
  emit(entries.filter((entry) => entry.id !== id));
}

/** Module state outlives a test: each test starts from no toast (not exported from the package index). */
export function resetToastsForTests(): void {
  emit([]);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const TOAST_TONES = { neutral: "border-border-strong", error: "border-err" } as const;

/** Bottom right on desktop, bottom on phones (above the bottom nav: the shell sets --toast-bottom). */
export function Toaster({ closeLabel }: { readonly closeLabel: string }) {
  const shown = useSyncExternalStore(subscribe, () => entries, () => entries);
  return (
    <Radix.Provider duration={DURATION_MS} swipeDirection="right">
      {shown.map((entry) => (
        <Radix.Root
          key={entry.id}
          onOpenChange={(open) => {
            if (!open) dismissToast(entry.id);
          }}
          data-slot="toast"
          className={cn("flex items-center gap-s2 rounded-md border bg-bg-side px-s3 py-s2 text-ui text-fg shadow-overlay animate-overlay-in", TOAST_TONES[entry.tone ?? "neutral"])}
        >
          <Radix.Description className="min-w-0 flex-1">{entry.message}</Radix.Description>
          {entry.action ? (
            <Radix.Action altText={entry.action.altText} onClick={entry.action.run} className="label-hud text-you rounded-sm px-s1 focus-ring pointer-coarse:min-h-11">
              {entry.action.label}
            </Radix.Action>
          ) : null}
          <Radix.Close aria-label={closeLabel} className="inline-flex size-6 items-center justify-center rounded-sm text-muted focus-ring pointer-coarse:size-11">
            <Icon icon={IconClose} size={14} />
          </Radix.Close>
        </Radix.Root>
      ))}
      <Radix.Viewport data-slot="toast-viewport" className="fixed bottom-s4 right-s4 z-50 flex w-96 max-w-full flex-col gap-s2 outline-none max-md:inset-x-s2 max-md:bottom-s2 max-md:w-auto" />
    </Radix.Provider>
  );
}
```

(On phones the shell lifts the viewport above the bottom nav with a `styles.css` rule in Task 23; the toast itself does not know about the nav.)

`apps/web/src/main.tsx`: define `function LocalizedToaster() { const t = useT(); return <Toaster closeLabel={t("ui.dismiss")} />; }` (a plain `t()` would keep the first language, R128) and render `<LocalizedToaster />` next to the router inside `TooltipProvider`; add to `catalog/shell.ts` the keys `"ui.dismiss": "Dismiss"` / `"Fermer"`, `"ui.close": "Close"` / `"Fermer"`.

`packages/ui/src/index.ts`: export `useMediaQuery`, `useIsPhone`, `Dialog`, `DialogProps`, `DialogVariant`, `Menu`, `MenuItem`, `toast`, `dismissToast`, `Toaster`, `ToastInput`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit packages/ui apps/web scripts/class-coverage.test.ts`
Expected: PASS. If Radix's focus return in happy-dom needs a frame, add `await settle()` (from the copied helpers) before the `activeElement` assertion — do not drop the assertion.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/ui apps/web/src/main.tsx apps/web/src/i18n/catalog/shell.ts
git commit -m "feat(ui): dialogs, sheets, drawers, menus and toasts with composition-safe Escape"
```

---
# Phase 3 — AI components and the logo

### Task 9: Message, AuthorGroup, DaySeparator, RunStatusChip, Fence (+ attribution)

DESIGN.md §9.2. Message keeps its M1 props (M2's transcript uses them) and gains the S6 port of AI Elements' actions and branch selector (with attribution, R53), `meta`, and `grouped` for messages inside an AuthorGroup (pw: `components/agents/conversation/author-groups.ts`, `GroupHeader.tsx`: consecutive messages share one avatar and header).

**Files:**
- Modify: `packages/ui/src/ai/Message.tsx`, `packages/ui/src/ai/Message.test.tsx`, `packages/ui/src/index.ts`
- Create: `packages/ui/src/ai/AuthorGroup.tsx`, `DaySeparator.tsx`, `RunStatusChip.tsx`, `Fence.tsx`, `conversation.test.tsx`
- Create: `THIRD_PARTY_NOTICES.md`, `LICENSES/Apache-2.0.txt` (the canonical licence text, M3-RT-06), `scripts/notices.test.ts`; modify `.prettierignore` (add `THIRD_PARTY_NOTICES.md` and `LICENSES/`, legal text kept byte for byte)

**Interfaces:**
- Consumes: `Chip`, `Icon`, `IconChevronLeft/Right`, `Tooltip` (Tasks 4, 5, 7).
- Produces:
  - `Message({ author: "agent" | "you" | "tool"; label: string; children; meta?: ReactNode; actions?: ReactNode; grouped?: boolean })`.
  - `MessageActions({ label: string; children })` (a labelled `role="group"`), `MessageAction({ label: string; icon: IconGlyph; ...button attributes })` (icon-only, tooltip = label).
  - `MessageBranch({ index: number; count: number; groupLabel: string; previousLabel: string; nextLabel: string; position: string; onChange(index: number): void })`.
  - `AuthorGroup({ author: "agent" | "you"; name: string; avatar?: ReactNode; meta?: ReactNode; children })`.
  - `DaySeparator({ label: string })`.
  - `type RunStatus = "working" | "settled" | "interrupted" | "limited" | "needs-input"`, `RunStatusChip({ status: RunStatus; label: string })`.
  - `Fence({ label: string; children })` — `label` is the full "UNTRUSTED · <source>" text, translated by the caller.

**Rulings (pre-dispatch):**
- The Apache-2.0 compliance follows S6's engineering reading (no legal review, known to the owner) and its full recipe: the notice, the upstream commit, a header on every derived file, and the canonical licence text for recipients in `LICENSES/Apache-2.0.txt` (M3-RT-06). The full 40-character commit `6a9d5b1822ffb10bba4bd97175f01edd7d8651cd` is the one S6 records (`docs/spikes/s6.md`, line 4). [M3R31]
- `Message` keeps its M1 props and DOM (agreement 5); model text is rendered through `Markdown` as its child (Task 10b), never by `Message` itself. [M3R32]
- The M1 class assertions of `Message.test.tsx` (`bg-human-tint`, `border-human-line`, `text-human-text`, `border-line`) are replaced by the DESIGN names (`bg-you-tint`, `border-you-line`, `text-you-text`, `border-border`); the M1 behaviour assertions stay (M3-RT-27). [M3R33]

- [ ] **Step 1: Write the failing tests**

In `packages/ui/src/ai/Message.test.tsx`, keep the M1 cases but replace their class expectations with the DESIGN names (`bg-human-tint` → `bg-you-tint`, `border-human-line` → `border-you-line`, `text-human-text` → `text-you-text`, `border-line` → `border-border`; the M1 file asserts the old names and would fail), then add:

```tsx
  it("shows your message as a right-aligned tint box and the agent's behind a 2 px violet rule", () => {
    const you = renderToStaticMarkup(<Message author="you" label="You">hi</Message>);
    for (const cls of ["ml-auto", "bg-you-tint", "border-you-line", "text-you-text"]) expect(you).toContain(cls);
    const agent = renderToStaticMarkup(<Message author="agent" label="Atlas">ok</Message>);
    expect(agent).toContain("border-l-2");
    expect(agent).toContain("border-agent");
  });

  it("drops its own header inside an author group and shows meta otherwise", () => {
    expect(renderToStaticMarkup(<Message author="agent" label="Atlas" grouped>ok</Message>)).not.toContain("<header");
    expect(renderToStaticMarkup(<Message author="agent" label="Atlas" meta="14:02">ok</Message>)).toContain(">14:02<");
  });
```

`packages/ui/src/ai/conversation.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../primitives/Tooltip.tsx";
import { click, mount } from "../testing/dom.ts";
import { AuthorGroup } from "./AuthorGroup.tsx";
import { DaySeparator } from "./DaySeparator.tsx";
import { Fence } from "./Fence.tsx";
import { Message, MessageBranch } from "./Message.tsx";
import { RunStatusChip } from "./RunStatusChip.tsx";

describe("conversation components (DESIGN.md §9.2)", () => {
  it("an author group shows one header for consecutive messages", () => {
    const html = renderToStaticMarkup(
      <AuthorGroup author="agent" name="Atlas" meta="14:02">
        <Message author="agent" label="Atlas" grouped>one</Message>
        <Message author="agent" label="Atlas" grouped>two</Message>
      </AuthorGroup>,
    );
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).toContain("text-agent");
  });

  it("a day separator is an inline labelled line, not sticky", () => {
    const html = renderToStaticMarkup(<DaySeparator label="Today" />);
    expect(html).toContain('role="separator"');
    expect(html).not.toContain("sticky");
  });

  it("maps run states to chip tones: needs input is attention, interrupted is error", () => {
    expect(renderToStaticMarkup(<RunStatusChip status="needs-input" label="Needs input" />)).toContain('data-tone="att"');
    expect(renderToStaticMarkup(<RunStatusChip status="interrupted" label="Interrupted" />)).toContain('data-tone="err"');
    expect(renderToStaticMarkup(<RunStatusChip status="working" label="Working" />)).toContain('data-tone="run"');
  });

  it("fences external content with a dashed attention frame and its label", () => {
    const html = renderToStaticMarkup(<Fence label="UNTRUSTED · webhook prod-alerts">payload</Fence>);
    expect(html).toContain("border-dashed");
    expect(html).toContain("border-attn");
    expect(html).toContain("UNTRUSTED · webhook prod-alerts");
  });

  it("the branch selector wraps around, hides below two and names its group", async () => {
    expect(renderToStaticMarkup(<MessageBranch index={0} count={1} groupLabel="Branches" previousLabel="Previous" nextLabel="Next" position="1 / 1" onChange={() => {}} />)).toBe("");
    const onChange = vi.fn();
    const page = await mount(
      <TooltipProvider>
        <MessageBranch index={0} count={3} groupLabel="Branches" previousLabel="Previous" nextLabel="Next" position="1 / 3" onChange={onChange} />
      </TooltipProvider>,
    );
    expect(page.container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Branches");
    await click(page.container.querySelector('button[aria-label="Previous"]') as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(2);
    await page.unmount();
  });
});
```

`scripts/notices.test.ts`:

```ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
// The text of https://www.apache.org/licenses/LICENSE-2.0.txt, as Debian and Ubuntu ship it in
// /usr/share/common-licenses/Apache-2.0 (checked on the build host when this plan was written).
const APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

describe("third-party notices (S6, R53)", () => {
  it("ships the canonical Apache-2.0 text, byte for byte", () => {
    expect(createHash("sha256").update(readFileSync(join(REPO, "LICENSES/Apache-2.0.txt"))).digest("hex")).toBe(APACHE_2_0_SHA256);
  });

  it("names the upstream commit and the licence file", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("6a9d5b1822ffb10bba4bd97175f01edd7d8651cd");
    expect(notices).toContain("LICENSES/Apache-2.0.txt");
  });

  it("lists every file whose header says it is derived from vercel/ai-elements", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    const derived = readdirSync(join(REPO, "packages/ui/src/ai"))
      .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
      .map((name) => `packages/ui/src/ai/${name}`)
      .filter((path) => read(path).includes("vercel/ai-elements"));
    expect(derived.length).toBeGreaterThanOrEqual(1);
    for (const path of derived) expect(notices, path).toContain(`\`${path}\``);
  });
});
```


- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/ai`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/ui/src/ai/Message.tsx`:

```tsx
/**
 * Message actions and branch selector derived from vercel/ai-elements, packages/elements/src/message.tsx
 * (commit 6a9d5b1), Copyright 2023 Vercel, Inc., Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
 * Changed by pap: shadcn primitives, the `ai` types and Streamdown are replaced by DESIGN.md tokens and owned
 * markup; the branch selector is controlled by the caller; the group carries an accessible name.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../cn.ts";
import { IconChevronLeft, IconChevronRight, type IconGlyph } from "../icons.ts";
import { Icon } from "../primitives/Icon.tsx";
import { Tooltip } from "../primitives/Tooltip.tsx";

export type Author = "agent" | "you" | "tool";

// DESIGN.md §9.2: the agent speaks behind a 2 px violet rule, you in a right-aligned tinted box.
const STYLE: Record<Author, { readonly box: string; readonly label: string }> = {
  agent: { box: "border-l-2 border-agent px-s3 py-s2 text-fg", label: "text-agent" },
  you: { box: "ml-auto w-fit max-w-prose rounded-md border border-you-line bg-you-tint px-s3 py-s2 text-you-text", label: "" },
  tool: { box: "border-l-2 border-border px-s3 py-s2 text-fg", label: "text-muted" },
};

export interface MessageProps {
  readonly author: Author;
  readonly label: string;
  readonly children: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  /** Inside an AuthorGroup: the group's header stands for this message's. */
  readonly grouped?: boolean;
}

export function Message({ author, label, children, meta, actions, grouped = false }: MessageProps) {
  return (
    <article data-slot="message" data-author={author} aria-label={grouped ? label : undefined} className={STYLE[author].box}>
      {grouped ? null : (
        <header className="flex items-baseline gap-s2">
          <span className={cn("label-hud", STYLE[author].label)}>{label}</span>
          {meta ? <span className="font-mono text-label tabular-nums text-muted">{meta}</span> : null}
        </header>
      )}
      <div className={cn("whitespace-pre-wrap break-words text-chat", grouped ? null : "mt-s1")}>{children}</div>
      {actions}
    </article>
  );
}

export function MessageActions({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="mt-s2 flex items-center gap-s1">
      {children}
    </div>
  );
}

export interface MessageActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "aria-label" | "children"> {
  readonly label: string;
  readonly icon: IconGlyph;
}

const ACTION_CLASSES =
  "inline-flex size-control items-center justify-center rounded-sm text-muted transition-colors duration-fast focus-ring can-hover:hover:bg-surface-2 can-hover:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11";

export function MessageAction({ label, icon, type = "button", ...rest }: MessageActionProps) {
  return (
    <Tooltip label={label}>
      <button type={type} aria-label={label} className={ACTION_CLASSES} {...rest}>
        <Icon icon={icon} size={14} />
      </button>
    </Tooltip>
  );
}

export interface MessageBranchProps {
  readonly index: number;
  readonly count: number;
  readonly groupLabel: string;
  readonly previousLabel: string;
  readonly nextLabel: string;
  /** "2 / 3", formatted by the caller. */
  readonly position: string;
  onChange(index: number): void;
}

export function MessageBranch({ index, count, groupLabel, previousLabel, nextLabel, position, onChange }: MessageBranchProps) {
  if (count <= 1) return null;
  return (
    <div role="group" aria-label={groupLabel} className="flex items-center gap-s1">
      <MessageAction label={previousLabel} icon={IconChevronLeft} onClick={() => onChange(index > 0 ? index - 1 : count - 1)} />
      <span className="font-mono text-label tabular-nums text-muted">{position}</span>
      <MessageAction label={nextLabel} icon={IconChevronRight} onClick={() => onChange(index < count - 1 ? index + 1 : 0)} />
    </div>
  );
}
```

`AuthorGroup.tsx`:

```tsx
import type { ReactNode } from "react";
import { cn } from "../cn.ts";

const NAME_TONES = { agent: "text-agent", you: "text-you" } as const;

/** Consecutive messages of one author under one avatar and header (pw: conversation view, GroupHeader). */
export function AuthorGroup({ author, name, avatar, meta, children }: { readonly author: keyof typeof NAME_TONES; readonly name: string; readonly avatar?: ReactNode; readonly meta?: ReactNode; readonly children: ReactNode }) {
  return (
    <section data-slot="author-group" data-author={author} aria-label={name} className="flex gap-s2">
      {avatar ? <div className="shrink-0 pt-0.5">{avatar}</div> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-s1">
        <header className="flex items-baseline gap-s2">
          <span className={cn("label-hud", NAME_TONES[author])}>{name}</span>
          {meta ? <span className="font-mono text-label tabular-nums text-muted">{meta}</span> : null}
        </header>
        {children}
      </div>
    </section>
  );
}
```

`DaySeparator.tsx`:

```tsx
/** An inline line with a mono label, not sticky (DESIGN.md §9.2, pw a1ba117). */
export function DaySeparator({ label }: { readonly label: string }) {
  return (
    <div data-slot="day-separator" role="separator" aria-label={label} className="flex items-center gap-s2 py-s2">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span aria-hidden className="label-hud text-muted">
        {label}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
```

`RunStatusChip.tsx`:

```tsx
import { Chip, type ChipTone } from "../primitives/Chip.tsx";

export type RunStatus = "working" | "settled" | "interrupted" | "limited" | "needs-input";

const RUN_TONES: Record<RunStatus, ChipTone> = {
  working: "run",
  settled: "ok",
  interrupted: "err",
  limited: "mut",
  "needs-input": "att",
};

export function RunStatusChip({ status, label }: { readonly status: RunStatus; readonly label: string }) {
  return <Chip tone={RUN_TONES[status]} label={label} dot={status === "working" || status === "needs-input"} />;
}
```

`Fence.tsx`:

```tsx
import type { ReactNode } from "react";

/** External content, fenced and labelled with its source (DESIGN.md §2, §11, decision 29). */
export function Fence({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <figure data-slot="fence" className="flex flex-col gap-s1 rounded-md border border-dashed border-attn p-s2">
      <figcaption className="label-hud text-attn">{label}</figcaption>
      <div className="whitespace-pre-wrap break-words font-mono text-code text-muted">{children}</div>
    </figure>
  );
}
```

The canonical licence text (the host has it; no network needed): `mkdir -p LICENSES && cp /usr/share/common-licenses/Apache-2.0 LICENSES/Apache-2.0.txt`. If that file is missing on the machine, take the same text from an Apache-2.0 package already in `node_modules` whose licence file has the digest above (check with `sha256sum`) — never from the network, never retyped.

`THIRD_PARTY_NOTICES.md`:

```markdown
# Third-party notices

## vercel/ai-elements

Some components in `packages/ui/src/ai/` (each marked by a header naming its source file) are derived from
vercel/ai-elements, commit 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd (https://github.com/vercel/ai-elements).

    Copyright 2023 Vercel, Inc.
    Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance
    with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
    Unless required by applicable law or agreed to in writing, software distributed under the License is distributed
    on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License
    for the specific language governing permissions and limitations under the License.

The Apache License, Version 2.0, is reproduced in full in `LICENSES/Apache-2.0.txt`.

Derived files (each carries a header naming its source file and what pap changed):

- `packages/ui/src/ai/Message.tsx` (from `packages/elements/src/message.tsx`)

pap does not depend on the AI Elements packages and does not use the Vercel or "AI Elements" names (spike S6, ruling R53).
```

`packages/ui/src/index.ts`: export `Message`, `MessageActions`, `MessageAction`, `MessageBranch`, their prop types, `AuthorGroup`, `DaySeparator`, `RunStatusChip`, `RunStatus`, `Fence`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit packages/ui apps/web scripts/class-coverage.test.ts`
Expected: PASS (M2's `SessionScreen` tests still pass: Message's M1 props and DOM are unchanged apart from classes). Mutation check: delete one line of `LICENSES/Apache-2.0.txt` → the digest case fails; restore it with `git checkout`.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/ui THIRD_PARTY_NOTICES.md LICENSES/Apache-2.0.txt scripts/notices.test.ts .prettierignore
git commit -m "feat(ui): message actions and branches, author groups, day separators, run status and fences"
```

---

### Task 10: Reasoning, ToolCard and the ApprovalCard's converged answers

Reasoning is ported from AI Elements' `reasoning.tsx` with attribution: it opens while the model streams and closes 1 s after, unless the person toggled it; no `Shimmer` (DESIGN §1 and §7.2 forbid it). ToolCard is written from the Pi event model with AI Elements' `tool.tsx` as a reference only (S6): mono upper-case tool name in agent colour, argument summary, duration, an output body, the indeterminate bar while running, and the compact / expanded / full detail level of Settings. ApprovalCard gains DESIGN's header (`Approval · <category>`, "external content" when tainted), context, and the converged answer API of agreement 6: the answers offered (`deny | once | session | always`, M2's contract names), their labels and one `onChoose` callback, shown in DESIGN order Deny / Session / Always / Allow once. Its M1 props keep working as a thin adapter (M2 uses them until P3).

**Files:**
- Create: `packages/ui/src/ai/Reasoning.tsx`, `Reasoning.test.tsx`, `ToolCard.tsx`, `ToolCard.test.tsx`
- Modify: `packages/ui/src/ai/ApprovalCard.tsx`, `ApprovalCard.test.tsx`, `packages/ui/src/index.ts`, `THIRD_PARTY_NOTICES.md` (Reasoning in the derived-file list)

**Interfaces:**
- Consumes: `Collapsible`, `ProgressBar`, `Chip`, `Button`, `once` (Tasks 4, 5, 7).
- Produces:
  - `Reasoning({ streaming: boolean; label: string; children })` — `label` is "Thinking…" while streaming and "Thought for 14s" after, formatted by the caller.
  - `type ToolDetail = "compact" | "expanded" | "full"`, `type ToolStatus = "running" | "done" | "error"`, `ToolCard({ name: string; summary?: string; duration?: string; status: ToolStatus; detail: ToolDetail; runningLabel: string; failedLabel: string; children?: ReactNode })`.
  - `type ApprovalAnswer = "deny" | "once" | "session" | "always"`; `APPROVAL_ORDER: readonly ApprovalAnswer[]` (`["deny", "session", "always", "once"]`, DESIGN §9.2).
  - `ApprovalCardProps = ApprovalCardChoiceProps | ApprovalCardM1Props`, both with `title`, `detail`, `category?: string`, `taintLabel?: string`, `context?: ReactNode`; `ApprovalCardChoiceProps` adds `answers?: readonly ApprovalAnswer[]` (default all four; `deny` is always offered), `labels: Readonly<Record<ApprovalAnswer, string>>`, `onChoose(answer: ApprovalAnswer): void`; `ApprovalCardM1Props` is M1's `allowLabel`, `denyLabel`, `onAnswer(approved: boolean)` (= answers `["deny", "once"]`).

**Rulings (pre-dispatch):**
- The ApprovalCard buttons follow DESIGN's order (Deny first); M2's tests select buttons by name, not order. [M3R34]
- The "Session/Always visual until M5" premise is wrong: M2 ships those answers (M2 Tasks 13/14/26). The card takes the converged API of agreement 6 (`answers` + `labels` + `onChoose`, one callback per click, so no double send); the M1 props stay as an adapter until P1; `deny` is always offered (a card can always be refused). P3 replaces M2's `ApprovalDialog` with this card and adds the type-level test `ApprovalAnswer (ui) ≡ ApprovalAnswer (contracts)` in `apps/web` (`@pap/ui` cannot import `@pap/contracts`). [M3R35]
- The header text stays sentence case in the DOM ("Approval · exec") and `label-hud` uppercases it in CSS (R121); M2's ApprovalDialog does the same, so P3 needs no test rewrite (agreement 6). Its colour is `text-attn-title` (ADR 0012). [M3R36]
- ToolCard opens by the detail setting until the person toggles it, and follows a later change of the setting until then (M3-RT-38). [M3R37]

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/ai/Reasoning.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount } from "../testing/dom.ts";
import { Reasoning } from "./Reasoning.tsx";

const isOpen = (container: HTMLElement) => container.querySelector('[data-slot="collapsible"]')?.getAttribute("data-state") === "open";

describe("Reasoning", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is open while streaming and closes 1 s after the stream ends", async () => {
    const page = await mount(<Reasoning streaming label="Thinking…">step one</Reasoning>);
    expect(isOpen(page.container)).toBe(true);
    await page.rerender(<Reasoning streaming={false} label="Thought for 14s">step one</Reasoning>);
    expect(isOpen(page.container)).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(isOpen(page.container)).toBe(false);
    await page.unmount();
  });

  it("starts closed for a finished message and leaves the person's choice alone", async () => {
    const page = await mount(<Reasoning streaming={false} label="Thought for 14s">step one</Reasoning>);
    expect(isOpen(page.container)).toBe(false);
    await click(page.container.querySelector("button") as HTMLElement);
    expect(isOpen(page.container)).toBe(true);
    await page.unmount();
  });
});
```

`packages/ui/src/ai/ToolCard.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolCard } from "./ToolCard.tsx";

const card = (detail: "compact" | "expanded" | "full", status: "running" | "done" | "error" = "done") =>
  renderToStaticMarkup(
    <ToolCard name="bash" summary="go test ./..." duration="00:07" status={status} detail={detail} runningLabel="Running" failedLabel="Failed">
      ok lanes 0.41s
    </ToolCard>,
  );

describe("ToolCard (DESIGN.md §9.2)", () => {
  it("names the tool in mono upper case in agent colour, with its summary and duration", () => {
    const html = card("expanded");
    expect(html).toContain("label-hud");
    expect(html).toContain("text-agent");
    expect(html).toContain("go test ./...");
    expect(html).toContain(">00:07<");
  });

  it("is one line in compact detail, clipped when expanded, whole when full", () => {
    expect(card("compact")).not.toContain("ok lanes 0.41s");
    expect(card("expanded")).toContain("max-h-64");
    expect(card("full")).not.toContain("max-h-64");
  });

  it("shows the indeterminate bar while running and a failed chip on error", () => {
    expect(card("compact", "running")).toContain("animate-indeterminate");
    expect(card("compact", "error")).toContain(">Failed<");
  });
});
```

Add to `packages/ui/src/ai/ApprovalCard.test.tsx` (turn it into `// @vitest-environment happy-dom`; keep the M1 cases, which use `allowLabel`/`denyLabel`/`onAnswer` and select buttons by name or variant, never by order, except that "styles the card as an attention-tinted card" expects `bg-attn-tint` and `border-attn-line` instead of the M1 names, M3-RT-27; add the imports `vi` from `vitest` and `button`, `click`, `mount` from `../testing/dom.ts`):

```tsx
const LABELS = { deny: "Deny", session: "Session", always: "Always", once: "Allow once" } as const;
const names = (container: HTMLElement) => [...container.querySelectorAll("button")].map((b) => b.textContent);

  it("offers all four answers by default, in DESIGN order, and calls onChoose once", async () => {
    const onChoose = vi.fn();
    const page = await mount(<ApprovalCard title="Approval" category="external write" taintLabel="External content" detail={"1 line\npush origin main"} labels={LABELS} onChoose={onChoose} />);
    expect(names(page.container)).toEqual(["Deny", "Session", "Always", "Allow once"]);
    expect(page.container.textContent).toContain("external write");
    expect(page.container.querySelector('[data-tone="ext"]')?.textContent).toBe("External content");
    await click(button(page.container, "Session"));
    await click(button(page.container, "Allow once"));
    expect(onChoose.mock.calls).toEqual([["session"]]);
    await page.unmount();
  });

  it("offers exactly the answers it is given, in DESIGN order, and always Deny", async () => {
    const page = await mount(<ApprovalCard title="Approval" detail="x" answers={["once", "session", "once"]} labels={LABELS} onChoose={() => {}} />);
    expect(names(page.container)).toEqual(["Deny", "Session", "Allow once"]);
    await page.unmount();
  });

  it("maps the M1 props to Deny and Allow once, and answers once", async () => {
    const onAnswer = vi.fn();
    const page = await mount(<ApprovalCard title="Approval" detail="x" allowLabel="Allow once" denyLabel="Deny" onAnswer={onAnswer} />);
    expect(names(page.container)).toEqual(["Deny", "Allow once"]);
    await click(button(page.container, "Allow once"));
    await click(button(page.container, "Deny"));
    expect(onAnswer.mock.calls).toEqual([[true]]);
    await page.unmount();
  });

  it("keeps the header in sentence case in the DOM; CSS uppercases it (R121)", () => {
    const html = renderToStaticMarkup(<ApprovalCard title="Approval" category="exec" detail="x" labels={LABELS} onChoose={() => {}} />);
    expect(html).toMatch(/<h3[^>]*class="[^"]*label-hud[^"]*text-attn-title/);
    expect(html).toContain(">Approval<");
    expect(html).not.toContain("APPROVAL");
  });
```

(`button` comes from the copied test helpers: add it to `packages/ui/src/testing/dom.ts` with the M1 implementation.)

Add to `ToolCard.test.tsx` (it already runs under happy-dom):

```tsx
  it("follows a later change of the detail setting until the person toggles it", async () => {
    const card = (detail: "compact" | "expanded") => <ToolCard name="bash" status="done" detail={detail} runningLabel="Running" failedLabel="Failed">out</ToolCard>;
    const page = await mount(card("compact"));
    expect(page.container.textContent).not.toContain("out");
    await page.rerender(card("expanded"));
    expect(page.container.textContent).toContain("out");
    await page.unmount();
  });
```

(with `mount` imported from `../testing/dom.ts`).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/ai`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/ui/src/ai/Reasoning.tsx`:

```tsx
/**
 * Derived from vercel/ai-elements, packages/elements/src/reasoning.tsx (commit 6a9d5b1), Copyright 2023 Vercel, Inc.,
 * Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md). Changed by pap: Shimmer, Streamdown and the motion
 * classes are removed (DESIGN.md §1, §7.2); the label and its duration come from the caller (Pi timestamps); open
 * state is derived without setting state inside an effect body.
 */
import { useEffect, useState, type ReactNode } from "react";
import { IconChevronRight } from "../icons.ts";
import { Collapsible } from "../primitives/Collapsible.tsx";
import { Icon } from "../primitives/Icon.tsx";

const AUTO_CLOSE_MS = 1000;

export interface ReasoningProps {
  readonly streaming: boolean;
  /** "Thinking…" while streaming, "Thought for 14s" after. */
  readonly label: string;
  readonly children: ReactNode;
}

export function Reasoning({ streaming, label, children }: ReasoningProps) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [previous, setPrevious] = useState(streaming);
  const [lingering, setLingering] = useState(false);
  // React's "adjust state when a prop changes" pattern: the stream just ended, stay open for a second.
  if (streaming !== previous) {
    setPrevious(streaming);
    setLingering(!streaming);
  }
  useEffect(() => {
    if (!lingering) return;
    const timer = window.setTimeout(() => setLingering(false), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [lingering]);
  const open = chosen ?? (streaming || lingering);
  return (
    <div data-slot="reasoning">
      <Collapsible
        open={open}
        onOpenChange={setChosen}
        trigger={
          <span className="flex items-center gap-s1 text-ui text-muted">
            <span className={open ? "rotate-90 transition-transform duration-fast" : "transition-transform duration-fast"}>
              <Icon icon={IconChevronRight} size={14} />
            </span>
            {label}
          </span>
        }
      >
        <div className="mt-s1 border-l border-border pl-s3 text-chat text-muted">{children}</div>
      </Collapsible>
    </div>
  );
}
```

`packages/ui/src/ai/ToolCard.tsx`:

```tsx
import { useState, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { Chip } from "../primitives/Chip.tsx";
import { Collapsible } from "../primitives/Collapsible.tsx";
import { ProgressBar } from "../primitives/ProgressBar.tsx";

export type ToolDetail = "compact" | "expanded" | "full";
export type ToolStatus = "running" | "done" | "error";

const FRAME_TONES = { running: "border-border-strong", done: "border-border-strong", error: "border-err" } as const;
const BODY_DETAIL = { compact: "max-h-64 overflow-auto", expanded: "max-h-64 overflow-auto", full: "" } as const;

export interface ToolCardProps {
  readonly name: string;
  readonly summary?: string;
  readonly duration?: string;
  readonly status: ToolStatus;
  /** Settings › Appearance › tool card detail (DESIGN.md §9.2, §13). */
  readonly detail: ToolDetail;
  readonly runningLabel: string;
  readonly failedLabel: string;
  readonly children?: ReactNode;
}

/** Written from the Pi tool call/result model; AI Elements' tool.tsx was a reference only (S6). */
export function ToolCard({ name, summary, duration, status, detail, runningLabel, failedLabel, children }: ToolCardProps) {
  // The setting decides until the person toggles this card; a later change of the setting is followed until then.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? detail !== "compact";
  const header = (
    <span className="flex min-w-0 flex-1 items-center gap-s2 px-s2 py-s1">
      <span className="label-hud shrink-0 text-agent">{name}</span>
      {summary ? <span className="min-w-0 flex-1 truncate font-mono text-code text-muted">{summary}</span> : <span className="flex-1" />}
      {status === "error" ? <Chip tone="err" label={failedLabel} /> : null}
      {duration ? <span className="shrink-0 font-mono text-label tabular-nums text-muted">{duration}</span> : null}
    </span>
  );
  return (
    <div data-slot="tool-card" data-status={status} className={cn("rounded-md border bg-surface", FRAME_TONES[status])}>
      {children === undefined ? (
        header
      ) : (
        <Collapsible open={open} onOpenChange={setChosen} trigger={header}>
          <pre className={cn("whitespace-pre-wrap break-words border-t border-border px-s2 py-s1 font-mono text-code text-fg", BODY_DETAIL[detail])}>{children}</pre>
        </Collapsible>
      )}
      {status === "running" ? <ProgressBar label={runningLabel} /> : null}
    </div>
  );
}
```

(Radix Collapsible does not render closed content, which is what the compact test relies on; if the pinned version renders it hidden instead, assert on `hidden` in the test rather than on absence.)

`packages/ui/src/ai/ApprovalCard.tsx`: keep the M1 structure (`splitDetail`, the lazy `once` guard, the latest-callback ref, the header that stays visible above the scrolling body, `role="alertdialog"` with `aria-label={props.title}` and `aria-describedby`) and change the props and the answer path:

```tsx
/** M2's contract names (agreement 6). P3 pins this union to the one in @pap/contracts with a type-level test. */
export type ApprovalAnswer = "deny" | "once" | "session" | "always";
/** DESIGN.md §9.2 order. */
export const APPROVAL_ORDER: readonly ApprovalAnswer[] = ["deny", "session", "always", "once"];

interface ApprovalCardCommon {
  readonly title: string;
  /** The complete, already escaped text of the request. Its first line is a header (size, lines, hidden characters). */
  readonly detail: string;
  /** DESIGN.md §9.2 header: "Approval · <category>". */
  readonly category?: string;
  /** Shown as the dashed "external content" chip when the run is tainted (spec C §5). */
  readonly taintLabel?: string;
  /** Diff stats, trigger, tests. */
  readonly context?: ReactNode;
}

/** The converged API (agreement 6): the answers offered, their labels, one callback per click. */
export interface ApprovalCardChoiceProps extends ApprovalCardCommon {
  /** Shown in DESIGN order whatever the order given; "deny" is always offered. Default: all four. */
  readonly answers?: readonly ApprovalAnswer[];
  readonly labels: Readonly<Record<ApprovalAnswer, string>>;
  onChoose(answer: ApprovalAnswer): void;
}

/** M1's props, kept until post-merge task P1 (agreement 5): Deny and Allow once. */
export interface ApprovalCardM1Props extends ApprovalCardCommon {
  readonly allowLabel: string;
  readonly denyLabel: string;
  onAnswer(approved: boolean): void;
}

export type ApprovalCardProps = ApprovalCardChoiceProps | ApprovalCardM1Props;

interface Choice {
  readonly answers: readonly ApprovalAnswer[];
  readonly labels: Readonly<Record<ApprovalAnswer, string>>;
  choose(answer: ApprovalAnswer): void;
}

/** One path for both prop shapes: the M1 props are the answers Deny and Allow once. Keys are unique by construction. */
function choiceOf(props: ApprovalCardProps): Choice {
  if ("onChoose" in props) {
    const offered = new Set<ApprovalAnswer>(props.answers ?? APPROVAL_ORDER);
    offered.add("deny");
    return { answers: APPROVAL_ORDER.filter((answer) => offered.has(answer)), labels: props.labels, choose: (answer) => props.onChoose(answer) };
  }
  return {
    answers: ["deny", "once"],
    labels: { deny: props.denyLabel, once: props.allowLabel, session: "", always: "" },
    choose: (answer) => props.onAnswer(answer !== "deny"),
  };
}
```

(The M1 branch never shows `session` or `always`; their labels only fill the record.) In the component:

```tsx
  const [answered, setAnswered] = useState(false);
  const { answers, labels, choose } = choiceOf(props);
  // The card can stay open for minutes: the answer goes to the latest callback, not the first render's.
  const latestChoose = useRef(choose);
  useEffect(() => {
    latestChoose.current = choose;
  });
  // Built on the first click, never during render: every button shares it for the card's whole life.
  const guard = useRef<((answer: ApprovalAnswer) => boolean) | null>(null);
  const answer = (choice: ApprovalAnswer) => {
    guard.current ??= once((value: ApprovalAnswer) => {
      setAnswered(true);
      latestChoose.current(value);
    });
    guard.current(choice);
  };
```

The header becomes (sentence case in the DOM, R121; `--attn-title`, ADR 0012):

```tsx
      <h3 className="flex flex-wrap items-center gap-s2 label-hud text-attn-title">
        <span>{props.title}</span>
        {props.category ? (
          <>
            <span aria-hidden>·</span>
            <span>{props.category}</span>
          </>
        ) : null}
        {props.taintLabel ? <Chip tone="ext" label={props.taintLabel} /> : null}
      </h3>
```

the frame `rounded-md border border-attn-line bg-attn-tint p-s3`, `{props.context ? <div className="mt-s2 text-ui text-muted">{props.context}</div> : null}` after the detail, and the buttons, in DESIGN order:

```tsx
      <div className="mt-s3 flex flex-wrap gap-s2">
        {answers.map((choice) => (
          <Button key={choice} variant={choice === "once" ? "primary" : "secondary"} disabled={answered} onClick={() => answer(choice)}>
            {labels[choice]}
          </Button>
        ))}
      </div>
```

No M1 test reads the button order (they select by name or by variant, `ApprovalCard.once.test.tsx` included); every M1 assertion (header kept visible, `aria-describedby`, double click answers once, latest callback) stays, with the DESIGN class names in the styling case.

`THIRD_PARTY_NOTICES.md`: add the bullet ``- `packages/ui/src/ai/Reasoning.tsx` (from `packages/elements/src/reasoning.tsx`)`` to the derived-file list (`scripts/notices.test.ts` fails without it).

`packages/ui/src/index.ts`: export `Reasoning`, `ReasoningProps`, `ToolCard`, `ToolCardProps`, `ToolDetail`, `ToolStatus`, `ApprovalAnswer`, `APPROVAL_ORDER`, `ApprovalCardChoiceProps`, `ApprovalCardM1Props` (`ApprovalCardProps` stays exported, now the union).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit packages/ui apps/web scripts/class-coverage.test.ts scripts/notices.test.ts apps/web/src/compiler-gate.test.ts`
Expected: PASS (the compiler gate accepts Reasoning's prop-change pattern; if it reports a bailout, keep the behaviour and restructure until it compiles, never disable the rule). M2's session screen still renders `ApprovalCard` with the M1 props unchanged. Mutation check: make `choiceOf` skip `offered.add("deny")` → "always Deny" fails; call both `latestChoose` and a second callback in the guard → "calls onChoose once" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/ui THIRD_PARTY_NOTICES.md
git commit -m "feat(ui): reasoning, tool card and the approval card's converged answer API"
```

---

### Task 10b: Markdown and code highlighting in messages, loaded lazily (owner R3-1)

New task (owner R3-1, agreement 9). M2 defers "markdown and code highlighting in messages" to M3; spec C §7 names pi-web's pipeline (`react-markdown` + `remark-gfm`, pw: `components/MarkdownBody.tsx`, `lib/markdown.ts`) and shiki loaded on demand. Model text is untrusted: no raw HTML ever becomes markup, a link opens only to `http:`, `https:` or `mailto:` with `rel="noopener noreferrer"`, and an image is never fetched. Highlighting uses shiki's **JavaScript regex engine**, so the CSP keeps `script-src 'self'` with no `'wasm-unsafe-eval'` (R74, unchanged, its test untouched). Both the renderer and the highlighter are lazy chunks: the initial bundle gains only the small `Markdown` wrapper. Tool-specific renderers (edit diff, codemode, MCP) are M6's, on DiffView (R50).

**Files:**
- Create: `packages/ui/src/ai/Markdown.tsx`, `packages/ui/src/ai/Markdown.test.tsx`, `packages/ui/src/ai/Markdown.fail.test.tsx`
- Create: `packages/ui/src/ai/markdown/render.tsx`, `render.test.tsx`, `CodeBlock.tsx`, `highlight.ts`, `highlight.test.ts`, `safe-url.ts`
- Create: `apps/web/src/markdown-build.int.test.ts`
- Modify: `packages/ui/package.json` (`react-markdown`, `remark-gfm`, `shiki`), `pnpm-lock.yaml`, `packages/ui/src/utilities.css` (code-highlight variables), `packages/ui/src/index.ts`, `apps/web/src/build-output.int.test.ts` (no `.wasm`)

**Interfaces:**
- Consumes: Task 1a utilities, the class and compiler gates (Task 2).
- Produces:
  - `Markdown({ text: string; onLoadError?(): void })` — plain `whitespace-pre-wrap` text at once, the rendered markdown once its chunk has loaded; if the chunk fails to load or the renderer throws, the plain text stays and `onLoadError` is called once. Used as `Message`'s child: `<Message author="agent" label={name}><Markdown text={text} /></Message>`.
  - `render.tsx` (lazy chunk): default export `MarkdownBody({ text: string })`; `MAX_MARKDOWN_CHARS = 100_000` (longer text is shown plain, unparsed).
  - `safe-url.ts`: `safeHref(raw: string): string | null` (absolute `http:`, `https:`, `mailto:` only).
  - `highlight.ts` (its own lazy chunk, imported dynamically by `CodeBlock` only, so shiki loads only when a code block appears): `type CodeToken = { readonly content: string; readonly color: string | null; readonly italic: boolean }`; `highlightCode(code: string, lang: string): Promise<CodeToken[][] | null>` (null for an unknown language or code over `MAX_HIGHLIGHT_CHARS = 20_000`).
  - CSS: `[data-slot="code-block"]` defines `--shiki-*` from role tokens (`utilities.css`).

**Rulings (pre-dispatch):**
- Pipeline: `react-markdown` with `remark-gfm` (pi-web's, spec C §7), `skipHtml` on (raw HTML in model text is dropped, never parsed), its default URL transform plus pap's `safeHref` on every link (absolute `http:`, `https:`, `mailto:` only; anything else renders as text), links open in a new tab with `rel="noopener noreferrer"`, images render as their alt text and never load (zero telemetry, CSP `img-src`), text over 100 000 characters is shown plain. pi-web's `rehype-raw`, `rehype-sanitize`, math and frontmatter plugins are not taken. [M3R38]
- Highlighting: shiki's core with its JavaScript regex engine and a css-variables theme; never the Oniguruma WASM engine, so the CSP stays as it is (R74) and `highlight.test.ts` proves it with `WebAssembly` stubbed to throw. Languages: a fixed list (TypeScript, TSX, JavaScript, JSX, JSON, Bash, Python, Diff, YAML, CSS, HTML, Markdown, Go, Rust, SQL), each loaded on first use; code over 20 000 characters stays plain. [M3R39]
- Colours: only the agent hue appears in code (code blocks are agent output, DESIGN §2): keywords `--agent`, comments `--text-muted` in italic, everything else `--text`. Defined on `[data-slot="code-block"]`, not `:root`, so a themed subtree re-themes code too. No ADR: DESIGN is silent on highlighting and this stays inside §2. [M3R40]
- Placement: `Markdown` lives in `packages/ui/src/ai` as `Message`'s body slot (S6 "Streamdown response → the pi-web markdown pipeline, a slot"); `Message` keeps its M1 props. M2's transcript adopts it in P3; Task 25's preview and Task 28's gallery use it in M3. [M3R41]
- Dependencies `react-markdown`, `remark-gfm` and `shiki` are pinned exactly in `@pap/ui` (`pnpm add -E`); `minimumReleaseAge` (3 days) is waited for, never bypassed. If one of them brings an install script, the implementer stops and asks (not in `onlyBuiltDependencies`); whether that happens is discovered during implementation. The exact shiki subpaths (`shiki/core`, `shiki/engine/javascript`, the per-language modules) and the `react-markdown` component props are verified against the pinned `.d.ts` and `exports`. [M3R42]
- Bundle: the `Markdown` wrapper chunk stays under 3 KB gzip (pinned by `markdown-build.int.test.ts`); the renderer and highlighter chunk sizes are recorded in the commit body. [M3R43]

- [ ] **Step 1: Add the dependencies**

Run: `pnpm --filter @pap/ui add -E react-markdown remark-gfm shiki`
Expected: three exact pins in `packages/ui/package.json`; record the versions pnpm chose in the commit body. If the pinned shiki ships its languages as a separate package (`@shikijs/langs`) that `@pap/ui` must import directly, add it the same way (pnpm does not let a package import a dependency it does not declare).

- [ ] **Step 2: Write the failing tests**

`packages/ui/src/ai/markdown/render.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownBody, { MAX_MARKDOWN_CHARS } from "./render.tsx";
import { safeHref } from "./safe-url.ts";

const html = (text: string) => renderToStaticMarkup(<MarkdownBody text={text} />);

describe("model markdown is untrusted text (checklist: no HTML or markdown injection)", () => {
  it("never turns raw HTML into elements", () => {
    const out = html('hi <img src=x onerror="alert(1)"> <script>alert(2)</script> <b>bold</b> **strong**');
    expect(out).not.toMatch(/<img|<script|<b>/);
    expect(out).toContain("<strong>strong</strong>");
  });

  it("keeps only absolute http, https and mailto links, opened safely; the others stay text", () => {
    const out = html("[a](https://e.test/x) [b](javascript:alert(1)) [c](/settings) [d](data:text/html,hi) [e](mailto:a@e.test)");
    expect(out).toContain('<a href="https://e.test/x" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('href="mailto:a@e.test"');
    expect(out).not.toMatch(/href="(?:javascript|data|\/settings)/i);
    for (const text of [">b<", ">c<", ">d<"]) expect(out).toContain(text);
  });

  it("never loads an image: it becomes its alt text", () => {
    const out = html("![a cat](https://e.test/cat.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("a cat");
  });

  it("renders GFM tables, and fenced code as a code block in plain text first", () => {
    const out = html("| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```");
    expect(out).toContain("<table");
    expect(out).toMatch(/<pre[^>]*data-slot="code-block"[^>]*data-lang="ts"/);
    expect(out).toContain("const x = 1;");
    expect(out).toContain("data-markdown-body");
  });

  it("shows text above the cap as plain text, unparsed", () => {
    const long = "**b** ".repeat(Math.ceil(MAX_MARKDOWN_CHARS / 6) + 1);
    expect(long.length).toBeGreaterThan(MAX_MARKDOWN_CHARS);
    const out = html(long);
    expect(out).not.toContain("<strong>");
    expect(out).toContain("data-markdown-plain");
  });
});

describe("safeHref", () => {
  it.each([
    ["https://e.test/a?b=1", "https://e.test/a?b=1"],
    ["http://e.test", "http://e.test/"],
    ["mailto:a@e.test", "mailto:a@e.test"],
    ["javascript:alert(1)", null],
    [" java\tscript:alert(1)", null],
    ["data:text/html,x", null],
    ["/settings", null],
    ["", null],
  ])("%j → %j", (raw, expected) => {
    expect(safeHref(raw)).toBe(expected);
  });
});
```

`packages/ui/src/ai/markdown/highlight.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightCode, MAX_HIGHLIGHT_CHARS } from "./highlight.ts";

describe("code highlighting with shiki's JavaScript regex engine (R74: no WebAssembly)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("highlights TypeScript without ever compiling WebAssembly", async () => {
    const refuse = () => {
      throw new Error("WebAssembly is not allowed by the CSP (R74)");
    };
    vi.stubGlobal("WebAssembly", { compile: refuse, instantiate: refuse, compileStreaming: refuse, instantiateStreaming: refuse, validate: refuse });
    const lines = await highlightCode("const x = 1; // one", "ts");
    const tokens = (lines ?? []).flat();
    expect(tokens.map((token) => token.content).join("")).toBe("const x = 1; // one");
    expect(tokens.find((token) => token.content.includes("one"))?.color).toBe("var(--shiki-token-comment)");
  });

  it("lets only css-variable colours through", async () => {
    const tokens = ((await highlightCode('import { a } from "b";\nfunction f() { return 1; }', "typescript")) ?? []).flat();
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) expect(token.color === null || /^var\(--shiki-[a-z-]+\)$/.test(token.color), token.color ?? "").toBe(true);
  });

  it("leaves unknown languages and oversized code plain", async () => {
    expect(await highlightCode("x", "brainfuck")).toBeNull();
    expect(await highlightCode("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "ts")).toBeNull();
  });
});
```

`packages/ui/src/ai/Markdown.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { Markdown } from "./Markdown.tsx";

describe("Markdown (lazy)", () => {
  it("shows the plain text at once, then the rendered markdown", async () => {
    const page = await mount(<Markdown text={"**hi** there"} />);
    expect(page.container.textContent).toContain("**hi** there");
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(page.container.querySelector("strong")?.textContent).toBe("hi");
    await page.unmount();
  });
});
```

`packages/ui/src/ai/Markdown.fail.test.tsx` (its own file: the mock applies to the whole file):

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { Markdown } from "./Markdown.tsx";

vi.mock("./markdown/render.tsx", () => {
  throw new Error("chunk gone after an update");
});

describe("Markdown when its chunk cannot load", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the plain text and reports once", async () => {
    const onLoadError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {}); // React logs the caught error
    const page = await mount(<Markdown text={"**hi**"} onLoadError={onLoadError} />);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(page.container.textContent).toBe("**hi**");
    expect(onLoadError).toHaveBeenCalledOnce();
    await page.unmount();
  });
});
```

(If `vi.dynamicImportSettled()` does not flush React's Suspense ping in the pinned versions, use `await vi.waitFor(() => expect(…).…, { timeout: 5_000 })` inside `act`; never a fixed sleep.)

`apps/web/src/markdown-build.int.test.ts`:

```ts
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");

// Owner R3-1, R74: markdown and highlighting are lazy chunks, and nothing in them needs WebAssembly.
describe("markdown build", () => {
  it("keeps the renderer and the highlighter out of Markdown's own chunk and emits no .wasm", async () => {
    const output = (await build({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      build: {
        write: false,
        lib: { entry: join(repoRoot, "packages/ui/src/ai/Markdown.tsx"), formats: ["es"], fileName: "markdown" },
        rollupOptions: { external: (id) => /^(react|react-dom)(\/|$)/.test(id) },
      },
    })) as Rollup.RollupOutput[];
    const files = output.flatMap((o) => o.output);
    const chunks = files.filter((file): file is Rollup.OutputChunk => file.type === "chunk");
    const entry = chunks.find((chunk) => chunk.isEntry);
    expect(files.some((file) => file.fileName.endsWith(".wasm"))).toBe(false);
    expect(entry?.code).not.toMatch(/data-markdown-body|pap-code/);
    const renderer = chunks.find((chunk) => chunk.code.includes("data-markdown-body"));
    expect(renderer).toBeDefined();
    expect(renderer?.code).not.toContain("pap-code"); // shiki waits for the first code block
    expect(chunks.some((chunk) => chunk.code.includes("pap-code"))).toBe(true);
    expect(gzipSync(entry?.code ?? "").length).toBeLessThan(3 * 1024);
    for (const chunk of chunks) console.info(`markdown build ${chunk.fileName}: ${(gzipSync(chunk.code).length / 1024).toFixed(1)} KB gzip`);
  }, 120_000);
});
```

(If Vite's lib mode inlines dynamic imports in the pinned version, set `rollupOptions.output.inlineDynamicImports: false`.)

Add to `apps/web/src/build-output.int.test.ts`, inside the existing `describe`:

```ts
  it("ships no WebAssembly: the CSP has no 'wasm-unsafe-eval' (R74)", () => {
    expect(assets.filter((name) => name.endsWith(".wasm"))).toEqual([]);
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/ai && pnpm test:int apps/web/src/markdown-build.int.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`packages/ui/src/ai/markdown/safe-url.ts`:

```ts
const ALLOWED = new Set(["http:", "https:", "mailto:"]);

/**
 * Model text is untrusted: only absolute http(s) and mailto links survive. A relative path (into pap), javascript:,
 * data: and anything the URL parser refuses render as plain text instead (the caller shows the link text).
 */
export function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // not an absolute URL: shown as text, which is the documented outcome
  }
  return ALLOWED.has(url.protocol) ? url.href : null;
}
```

`packages/ui/src/ai/markdown/highlight.ts`:

```ts
import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export interface CodeToken {
  readonly content: string;
  readonly color: string | null;
  readonly italic: boolean;
}

export const MAX_HIGHLIGHT_CHARS = 20_000;
const THEME = "pap-code";
const SAFE_COLOR = /^var\(--shiki-[a-z-]+\)$/;

// One module per language, loaded on first use (each is its own chunk). Aliases map to the module's own name.
const LOADERS = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
} as const;
type Language = keyof typeof LOADERS;
const ALIASES: Readonly<Record<string, Language>> = { ts: "typescript", js: "javascript", sh: "bash", shell: "bash", zsh: "bash", py: "python", yml: "yaml", md: "markdown", rs: "rust" };

let highlighter: Promise<HighlighterCore> | null = null;
// Bounded by LOADERS: at most one entry per language.
const loaded = new Map<Language, Promise<void>>();

function core(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-", fontStyle: true })],
    langs: [],
    // The JavaScript engine: no WebAssembly, so the CSP needs no 'wasm-unsafe-eval' (R74).
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).catch((error: unknown) => {
    highlighter = null; // the next code block tries again
    throw error;
  });
  return highlighter;
}

function languageOf(lang: string): Language | null {
  const name = lang.trim().toLowerCase();
  if (name in LOADERS) return name as Language;
  return ALIASES[name] ?? null;
}

/** Tokens per line with css-variable colours, or null when the code stays plain (unknown language, too long). */
export async function highlightCode(code: string, lang: string): Promise<CodeToken[][] | null> {
  const language = languageOf(lang);
  if (language === null || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const shiki = await core();
  let ready = loaded.get(language);
  if (!ready) {
    ready = LOADERS[language]().then((module) => shiki.loadLanguage(module.default));
    loaded.set(language, ready);
    // A failed load is forgotten so the next block tries again; this call still rejects to its caller.
    ready.catch(() => loaded.delete(language));
  }
  await ready;
  return shiki.codeToTokens(code, { lang: language, theme: THEME }).tokens.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color !== undefined && SAFE_COLOR.test(token.color) ? token.color : null,
      // shiki's FontStyle flags: 1 is italic.
      italic: ((token.fontStyle ?? 0) & 1) === 1,
    })),
  );
}
```

(Verify against the pinned shiki: the names `createHighlighterCore`, `createCssVariablesTheme`, `createJavaScriptRegexEngine` and its `forgiving` option, the `codeToTokens(...).tokens` shape, the `FontStyle` italic flag, and the per-language module path — `shiki/langs/<name>.mjs` or `@shikijs/langs/<name>` — before writing; keep the behaviour and the tests. The engine's default regex target is runtime detection, which keeps Safari 16.4 working (no RegExp `v` flag there); if the pinned version has no detection, pass the ES2018 target.)

`packages/ui/src/ai/markdown/CodeBlock.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { CodeToken } from "./highlight.ts";

const PRE_CLASSES = "overflow-x-auto rounded-md border border-border bg-surface p-s2 font-mono text-code";
let warned = false;

/** Plain first; the highlighted tokens replace it when they arrive for the same code (a stale answer is dropped). */
export function CodeBlock({ code, lang }: { readonly code: string; readonly lang: string }) {
  const [highlighted, setHighlighted] = useState<{ readonly code: string; readonly lang: string; readonly lines: CodeToken[][] } | null>(null);
  useEffect(() => {
    let current = true;
    // shiki loads with the first code block, not with the markdown renderer.
    import("./highlight.ts")
      .then(({ highlightCode }) => highlightCode(code, lang))
      .then(
        (lines) => {
          if (current && lines) setHighlighted({ code, lang, lines });
        },
        () => {
          // Highlighting only adds colour: the plain block stays on screen. One bounded line per page, no content.
          if (warned) return;
          warned = true;
          console.warn("pap: code_highlight_failed");
        },
      );
    return () => {
      current = false;
    };
  }, [code, lang]);
  const lines = highlighted && highlighted.code === code && highlighted.lang === lang ? highlighted.lines : null;
  return (
    <pre data-slot="code-block" data-lang={lang || undefined} className={PRE_CLASSES}>
      <code>
        {lines
          ? lines.map((line, row) => (
              <span key={row} className="block">
                {line.map((token, column) => (
                  <span key={column} className={token.italic ? "italic" : undefined} style={token.color ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))}
              </span>
            ))
          : code}
      </code>
    </pre>
  );
}
```

(A failed highlight leaves the plain code, which the person already reads, and writes one `pap: code_highlight_failed` line per page: `reportClientIssue` lives in the web app, which `@pap/ui` cannot import. Lines and tokens have no identity of their own and never reorder, so the index keys are stable by construction.)

`packages/ui/src/ai/markdown/render.tsx`:

```tsx
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../cn.ts";
import { CodeBlock } from "./CodeBlock.tsx";
import { safeHref } from "./safe-url.ts";

export const MAX_MARKDOWN_CHARS = 100_000;

const BODY_CLASSES = "flex min-w-0 flex-col gap-s2 whitespace-normal break-words text-chat";
const PLAIN_CLASSES = "whitespace-pre-wrap break-words text-chat";
const LINK_CLASSES = "text-agent underline underline-offset-2 focus-ring";
const INLINE_CODE_CLASSES = "rounded-sm bg-surface-2 px-1 font-mono text-code";
const LIST_CLASSES = "flex flex-col gap-s1 pl-s4";
const TABLE_CLASSES = "w-full border-collapse text-ui";
const CELL_CLASSES = "border border-border px-s2 py-s1 text-left align-top";
const QUOTE_CLASSES = "border-l-2 border-border pl-s3 text-muted";

/** The hast node react-markdown hands to a component, read structurally (no direct dependency on hast's types). */
interface HastNode {
  readonly type?: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly children?: readonly HastNode[];
}

const textOf = (node: HastNode | undefined): string => (node?.value ?? "") + (node?.children ?? []).map(textOf).join("");

function fenced(node: HastNode | undefined): { code: string; lang: string } {
  const code = node?.children?.find((child) => child.tagName === "code");
  const classes = code?.properties?.className;
  const lang = (Array.isArray(classes) ? classes : []).map(String).find((name) => name.startsWith("language-"))?.slice(9) ?? "";
  return { code: textOf(code).replace(/\n$/, ""), lang };
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = href ? safeHref(href) : null;
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  // An image would be a request to wherever the model pointed (zero telemetry, CSP img-src): show its alt text.
  img: ({ alt }) => <span>{alt ?? ""}</span>,
  pre: ({ node }) => {
    const { code, lang } = fenced(node as HastNode | undefined);
    return <CodeBlock code={code} lang={lang} />;
  },
  code: ({ children }) => <code className={INLINE_CODE_CLASSES}>{children}</code>,
  ul: ({ children }) => <ul className={cn(LIST_CLASSES, "list-disc")}>{children}</ul>,
  ol: ({ children }) => <ol className={cn(LIST_CLASSES, "list-decimal")}>{children}</ol>,
  blockquote: ({ children }) => <blockquote className={QUOTE_CLASSES}>{children}</blockquote>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASSES}>{children}</table>
    </div>
  ),
  th: ({ children }) => <th className={cn(CELL_CLASSES, "font-semibold")}>{children}</th>,
  td: ({ children }) => <td className={CELL_CLASSES}>{children}</td>,
  h1: ({ children }) => <p className="font-bold">{children}</p>,
  h2: ({ children }) => <p className="font-bold">{children}</p>,
  h3: ({ children }) => <p className="font-semibold">{children}</p>,
  h4: ({ children }) => <p className="font-semibold">{children}</p>,
  h5: ({ children }) => <p className="font-semibold">{children}</p>,
  h6: ({ children }) => <p className="font-semibold">{children}</p>,
};

/** pi-web's pipeline (react-markdown + remark-gfm) without raw HTML; lazy-loaded by Markdown.tsx. */
export default function MarkdownBody({ text }: { readonly text: string }) {
  if (text.length > MAX_MARKDOWN_CHARS) {
    return (
      <div data-markdown-plain="" className={PLAIN_CLASSES}>
        {text}
      </div>
    );
  }
  return (
    <div data-markdown-body="" className={BODY_CLASSES}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
```

(Model headings stay inside the message's type scale and out of the page's heading outline: a chat message never prints an `h1`. Verify the `Components` prop shapes against the pinned `react-markdown` `.d.ts`; `node` is the hast element.)

`packages/ui/src/ai/Markdown.tsx`:

```tsx
import { Component, lazy, Suspense, type ReactNode } from "react";

const MarkdownBody = lazy(() => import("./markdown/render.tsx"));
const PLAIN_CLASSES = "whitespace-pre-wrap break-words";

interface FallbackProps {
  readonly fallback: ReactNode;
  readonly onError?: () => void;
  readonly children: ReactNode;
}

/** A chunk that fails to load (an update renamed it while the page stayed open) or a renderer that throws leaves the plain text. */
class PlainOnError extends Component<FallbackProps, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onError?.();
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Model text as markdown (DESIGN §9.2 message body), loaded on first use; plain text until then and if it fails. */
export function Markdown({ text, onLoadError }: { readonly text: string; readonly onLoadError?: () => void }) {
  const plain = (
    <div data-slot="markdown" className={PLAIN_CLASSES}>
      {text}
    </div>
  );
  return (
    <PlainOnError fallback={plain} onError={onLoadError}>
      <Suspense fallback={plain}>
        <MarkdownBody text={text} />
      </Suspense>
    </PlainOnError>
  );
}
```

Append to `packages/ui/src/utilities.css`:

```css
/* Code highlighting (Task 10b): shiki's css-variables theme mapped to role tokens on the block itself, so a themed
   subtree re-themes it. Only the agent hue appears: code blocks are agent output (DESIGN.md §2). */
[data-slot="code-block"] {
  --shiki-foreground: var(--text);
  --shiki-background: transparent;
  --shiki-token-keyword: var(--agent);
  --shiki-token-comment: var(--text-muted);
  --shiki-token-string: var(--text);
  --shiki-token-string-expression: var(--text);
  --shiki-token-constant: var(--text);
  --shiki-token-function: var(--text);
  --shiki-token-parameter: var(--text);
  --shiki-token-punctuation: var(--text-muted);
  --shiki-token-link: var(--agent);
}
```

`packages/ui/src/index.ts`: export `Markdown` (the renderer and highlighter stay internal: they are lazy chunks).

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit packages/ui scripts/class-coverage.test.ts scripts/literal-coverage.test.ts apps/web/src/compiler-gate.test.ts && pnpm test:int apps/web/src/markdown-build.int.test.ts apps/web/src/build-output.int.test.ts && pnpm lint && pnpm knip`
Expected: PASS. Mutation checks: remove `skipHtml` → "never turns raw HTML into elements" fails; return `url.href` without the protocol check → the `javascript:` and `data:` cases fail; import `highlight.ts` statically in `CodeBlock` → the build test's "shiki waits for the first code block" fails. Copy the chunk sizes the build test prints into the commit body.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/ui apps/web/src/markdown-build.int.test.ts apps/web/src/build-output.int.test.ts pnpm-lock.yaml
git commit -m "feat(ui): lazy markdown and code highlighting in messages, without WebAssembly"
```

---

### Task 11: The logo — Mark, Wordmark, favicon

DESIGN.md §6 (decision 26): the "two legs" π on a 32-unit grid, agent left in violet, you right in orange, top bar in text colour; `pap` in Manrope 800, −0.02em, lower case; tagline in mono upper case. The React Mark paints with the theme's role tones, so the day variant gets the darkened legs on its own. Static icons are SVG files (they cannot read CSS variables).

**Files:**
- Create: `packages/ui/src/brand/Mark.tsx`, `packages/ui/src/brand/Wordmark.tsx`, `packages/ui/src/brand/brand.test.tsx`
- Create: `apps/web/public/favicon.svg`, `apps/web/icons-src/favicon-tile.svg` (same content), `apps/web/icons-src/pwa-maskable.svg`, `apps/web/icons-src/apple-touch.svg`
- Modify: `apps/web/index.html`, `apps/web/src/build-output.int.test.ts`, `packages/ui/src/index.ts`

**Interfaces:**
- Produces: `Mark({ size?: number; mode?: "night" | "day"; label?: string })` (min 16 px), `Wordmark({ name: string; tagline?: string })`; the SVG sources `apps/web/icons-src/*.svg` that M12 renders to PNG.

**Rulings (pre-dispatch):**
- PNG favicons, the Apple touch icon and the PWA icons are deferred to M12 with the manifest (rendering them needed the browser container, removed by owner C1). Until then Safari shows no tab icon (it ignores SVG favicons): accepted. The SVG sources ship now so M12 only renders them. [M3R44]
- The build output references only `/assets/*` and `/favicon.svg` (no `/icons/` path in M3). [M3R44]

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/brand/brand.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Mark } from "./Mark.tsx";
import { Wordmark } from "./Wordmark.tsx";

describe("logo (DESIGN.md §6)", () => {
  it("draws the two legs on the 32-unit grid: bar in text colour, agent left, you right", () => {
    const svg = renderToStaticMarkup(<Mark label="pap" />);
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toContain('<rect class="fill-fg" x="6" y="9" width="20" height="3.2"');
    expect(svg).toContain('<rect class="fill-agent" x="10.4" y="12" width="3.2" height="13"');
    expect(svg).toContain('class="fill-you" d="M18.6 12h3.2v9.4c0 1.4.5 2 1.6 2h.9V26h-1.6c-2.8 0-4.1-1.4-4.1-4.4z"');
    expect(svg).toContain('role="img"');
  });

  it("never goes below 16 px and can pin a theme's tones", () => {
    expect(renderToStaticMarkup(<Mark size={8} />)).toContain('width="16"');
    expect(renderToStaticMarkup(<Mark mode="day" />)).toContain('data-theme="day"');
    expect(renderToStaticMarkup(<Mark />)).toContain('aria-hidden="true"');
  });

  it("sets the name in Manrope 800, lower case, tight, with a mono tagline", () => {
    const html = renderToStaticMarkup(<Wordmark name="pap" tagline="pi agentic platform" />);
    for (const cls of ["font-extrabold", "tracking-display", "lowercase", "label-hud"]) expect(html).toContain(cls);
  });
});
```

In `apps/web/src/build-output.int.test.ts`, change the "loads only from its own origin" expectation to `expect(reference, String(reference)).toMatch(/^\/(?:assets\/|favicon\.svg$)/);` and add:

```ts
  it("names the tab pap and serves the favicon from the build", async () => {
    expect(html).toContain("<title>pap</title>");
    expect(html).toContain('href="/favicon.svg"');
    expect((await readFile(join(out, "favicon.svg"), "utf8")).startsWith("<svg")).toBe(true);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/brand && pnpm test:int apps/web/src/build-output.int.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/ui/src/brand/Mark.tsx`:

```tsx
export interface MarkProps {
  readonly size?: number;
  /** Pins a theme's tones (data-theme on the svg); by default the mark follows the page's theme. */
  readonly mode?: "night" | "day";
  /** Accessible name; decorative without one. */
  readonly label?: string;
}

/** DESIGN.md §6.1: an agent and a human under one roof. Agent is always left and violet, you always right and orange. */
export function Mark({ size = 24, mode, label }: MarkProps) {
  const px = Math.max(16, size);
  return (
    <svg data-slot="mark" data-theme={mode} viewBox="0 0 32 32" width={px} height={px} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      <rect className="fill-fg" x="6" y="9" width="20" height="3.2" />
      <rect className="fill-agent" x="10.4" y="12" width="3.2" height="13" />
      <path className="fill-you" d="M18.6 12h3.2v9.4c0 1.4.5 2 1.6 2h.9V26h-1.6c-2.8 0-4.1-1.4-4.1-4.4z" />
    </svg>
  );
}
```

`packages/ui/src/brand/Wordmark.tsx`:

```tsx
/** DESIGN.md §6.2: `pap` in Manrope 800, −0.02em, lower case; the optional tagline in mono upper case, muted. */
export function Wordmark({ name, tagline }: { readonly name: string; readonly tagline?: string }) {
  return (
    <span data-slot="wordmark" className="inline-flex items-baseline gap-s2">
      <span className="font-sans text-h1 font-extrabold tracking-display lowercase text-fg">{name}</span>
      {tagline ? <span className="label-hud text-muted">{tagline}</span> : null}
    </span>
  );
}
```

`apps/web/public/favicon.svg` and `apps/web/icons-src/favicon-tile.svg` (night tones on a `--surface` tile, DESIGN §6.3; the clear space around the 20-unit-wide mark is 6 units, more than a quarter of its width):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="3" fill="#1A1724"/><rect x="6" y="9" width="20" height="3.2" fill="#F2EFFA"/><rect x="10.4" y="12" width="3.2" height="13" fill="#A78BFA"/><path d="M18.6 12h3.2v9.4c0 1.4.5 2 1.6 2h.9V26h-1.6c-2.8 0-4.1-1.4-4.1-4.4z" fill="#FB923C"/></svg>
```

`apps/web/icons-src/pwa-maskable.svg` (night background, mark scaled to 75 % around the centre so it stays inside the maskable safe circle):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#110F18"/><g transform="translate(16 17.5) scale(0.75) translate(-16 -17.5)"><rect x="6" y="9" width="20" height="3.2" fill="#F2EFFA"/><rect x="10.4" y="12" width="3.2" height="13" fill="#A78BFA"/><path d="M18.6 12h3.2v9.4c0 1.4.5 2 1.6 2h.9V26h-1.6c-2.8 0-4.1-1.4-4.1-4.4z" fill="#FB923C"/></g></svg>
```

`apps/web/icons-src/apple-touch.svg`: the maskable source without the scale (`<g>` removed, same night background).

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" content="#14111d" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <title>pap</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/ui/src/index.ts`: export `Mark`, `MarkProps`, `Wordmark`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit packages/ui && pnpm test:int apps/web/src/build-output.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/ui apps/web/public apps/web/icons-src apps/web/index.html apps/web/src/build-output.int.test.ts
git commit -m "feat(ui): the two-legs mark, the pap wordmark and the favicon"
```

---
# Phase 4 — Account settings and appearance

### Task 12: Contracts `settings.*` and the daemon `settings` module

DESIGN.md §13 and §14: account-scope appearance lives in "the `settings` module (account scope)"; spec C §3.2 lists the `settings` table. Keybindings ride on the same module (owner M3-Q3: per account, on the server). New files only, plus the small hunks in shared files listed in "Coordination with M2" (owner R3-8, agreement 13). Values are validated by the contracts schemas before they are stored, so the server never keeps a document the client could not read back. A write is a compare-and-set on the document's revision (owner R3-4, M3-RT-01): a write based on a revision that moved is refused with `conflict`, never applied over the newer copy.

**Files:**
- Create: `packages/contracts/src/settings.ts`, `packages/contracts/src/settings.test.ts`
- Modify: `packages/contracts/src/permissions.ts`, `packages/contracts/src/methods.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/methods.test.ts`
- Create: `apps/daemon/src/modules/settings/index.ts`, `service.ts`, `store.ts`, `rpc.ts`, `migrations/202610111000_settings.sql`, `service.test.ts`
- Create: `apps/daemon/src/daemon.settings.int.test.ts`
- Modify: `apps/daemon/src/daemon.ts`

**Interfaces:**
- Consumes: `defineMethod`, `PapError`, `Caller`, kernel `Db`, `Clock`, `MigrationSource`, `migrate`.
- Produces:
  - `createSettingsService({ store, clock, logger })` logs `settings_row_unreadable { key }` (never the value) when a stored document does not parse.
  - `THEME_ROLES`, `ThemeRoles`, `PRESET_THEME_IDS = ["night", "day", "hc"]`, `CustomTheme` (+ type; refuses a preset id), `AccountAppearanceFields` (the plain object, every field with a `.default()`), `AccountAppearance` (+ type; the fields plus the cross-field rules), `KEY_NONE = "none"`, `KeybindingRule` (+ type), `KeybindingRules`, `SETTING_KEYS`, `SettingKey` (+ type), `MAX_SETTING_BYTES = 131072`, `SettingWrite` (+ type; `{ key, value, baseRevision }`), `settingsMethods`.
  - Methods `settings.get { key } → { value: unknown | null; revision: number }` (`settings:read`, idempotent) and `settings.set { key, value, baseRevision } → { revision }` (`settings:operate`, mutation with `commandId`, errors `payload_too_large`, `conflict`).
  - Permission domain `settings`.
  - `SettingsStore.put(ownerId, key, value, baseRevision, now): number | null` (null = the stored revision moved); `SETTINGS_MIGRATIONS`, `createSettingsModule({ db, clock, logger }): { rpc: SettingsRpc }`.

**Rulings (pre-dispatch):**
- The module, its contracts file and the `settings` permission domain sit in M2-owned areas: accepted by the owner (R3-8, agreement 13); the shared-file hunks are one line each and the task is Opus-reviewed. [M3R45]
- Keybindings are stored per account on the server (owner M3-Q3); digits and punctuation are recorded by physical key (owner R3-7, Task 16a). [M3R46]
- On a read-only database (written by a newer pap) `settings.set` fails like every other write (`read_only`). [M3R47]
- Compare-and-set (owner R3-4): `settings.set` carries `baseRevision` (0 = create); the store writes in one statement (`UPDATE … WHERE owner_id = ? AND key = ? AND revision = $base`, or `INSERT … ON CONFLICT DO NOTHING` for 0) and a miss is `conflict` with the stored document unchanged. Never last-writer-wins. [M3R48]
- Every `AccountAppearance` field has a `.default()`, so a document written before a field existed still reads, on the server and in the client's field-wise parse (Task 13); the preset ids `night`, `day`, `hc` are refused as custom theme ids (M3-RT-09). [M3R49]
- The 128 KiB cap is pinned by a test that crosses it with two-byte characters and asserts the payload size before calling `set` (M3-RT-08). [M3R50]
- The migration keeps the stamp `202610111000_settings.sql`; the branch that merges second re-stamps its migrations after the newest stamp on `main` during its rebase (agreement 1, M3-RT-10). With M2 first, M3's stamp already sorts after M2's `202610110000` and `202610110100`; the rebase checks M2's final stamps. [M3R51]

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AccountAppearance, CustomTheme, KeybindingRules, SettingWrite } from "./settings.ts";

const base = {
  mode: "system",
  darkTheme: "night",
  lightTheme: "day",
  customThemes: [],
  uiFont: "manrope",
  monoFont: "jetbrains-mono",
  uppercaseLabels: true,
  grid: true,
  railPosition: "left",
  avatarStyle: "outlined",
  toolDetail: "compact",
} as const;
const withoutGrid = Object.fromEntries(Object.entries(base).filter(([name]) => name !== "grid"));
const ocean = { id: "ocean", name: "Ocean", base: "night", roles: { bg: "#0E1626", surface: "#132033", text: "#E6EDF7", agent: "#38BDF8", you: "#FB923C", attn: "#EC4899", ok: "#34D399", err: "#F87171" } } as const;

describe("account appearance", () => {
  it("accepts the defaults and a custom dark theme in use", () => {
    expect(AccountAppearance.safeParse(base).success).toBe(true);
    expect(AccountAppearance.safeParse({ ...base, customThemes: [ocean], darkTheme: "ocean" }).success).toBe(true);
  });

  it("refuses a theme that does not exist or sits on the wrong side, and duplicate ids", () => {
    expect(AccountAppearance.safeParse({ ...base, darkTheme: "ocean" }).success).toBe(false);
    expect(AccountAppearance.safeParse({ ...base, customThemes: [ocean], lightTheme: "ocean" }).success).toBe(false);
    expect(AccountAppearance.safeParse({ ...base, customThemes: [ocean, ocean] }).success).toBe(false);
  });

  it("lets only hex colours into a theme (no url(), no names, no alpha)", () => {
    for (const bad of ["url(https://x.test/a)", "red", "#fff", "#11223344", "var(--x)"]) {
      expect(AccountAppearance.safeParse({ ...base, customThemes: [{ ...ocean, roles: { ...ocean.roles, bg: bad } }] }).success, bad).toBe(false);
    }
  });

  it("refuses a custom theme that takes a preset's id (M3-RT-09)", () => {
    for (const id of ["night", "day", "hc"]) expect(CustomTheme.safeParse({ ...ocean, id }).success, id).toBe(false);
  });

  it("reads a document written before a field existed: the missing field takes its default", () => {
    expect(AccountAppearance.parse(withoutGrid)).toEqual(base);
    expect(AccountAppearance.parse({})).toEqual(base);
  });
});

describe("keybinding rules", () => {
  it("caps the list at 256 rules and refuses odd command ids", () => {
    const rule = { key: "mod+k", command: "palette.toggle" };
    expect(KeybindingRules.safeParse(Array.from({ length: 256 }, () => rule)).success).toBe(true);
    expect(KeybindingRules.safeParse(Array.from({ length: 257 }, () => rule)).success).toBe(false);
    expect(KeybindingRules.safeParse([{ key: "mod+k", command: "rm -rf /" }]).success).toBe(false);
  });
});

describe("setting writes", () => {
  it("pairs each key with its own schema and always names the revision it was based on", () => {
    expect(SettingWrite.safeParse({ key: "keybindings", value: [], baseRevision: 0 }).success).toBe(true);
    expect(SettingWrite.safeParse({ key: "keybindings", value: [] }).success).toBe(false);
    expect(SettingWrite.safeParse({ key: "keybindings", value: [], baseRevision: -1 }).success).toBe(false);
    expect(SettingWrite.safeParse({ key: "keybindings", value: base, baseRevision: 0 }).success).toBe(false);
    expect(SettingWrite.safeParse({ key: "theme", value: {}, baseRevision: 0 }).success).toBe(false);
  });
});
```

Change the mutation list in `packages/contracts/src/methods.test.ts` to include `"settings.set"` (sorted).

`apps/daemon/src/modules/settings/service.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_PERMISSIONS, MAX_SETTING_BYTES, PapError, type Caller } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createLogger } from "../../kernel/logger.ts";
import { createSettingsService, type SettingsService } from "./service.ts";
import { createSettingsStore } from "./store.ts";
import { SETTINGS_MIGRATIONS } from "./index.ts";

const owner = (userId: string): Caller => ({ userId, permissions: new Set(ALL_PERMISSIONS) });
const appearance = { mode: "day", darkTheme: "night", lightTheme: "day", customThemes: [], uiFont: "system", monoFont: "jetbrains-mono", uppercaseLabels: false, grid: true, railPosition: "right", avatarStyle: "glyph", toolDetail: "full" } as const;

let root: string;
let db: Db;
let service: SettingsService;
let lines: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-settings-"));
  const clock = createFakeClock();
  const logger = createLogger({ level: "error", clock, write: () => {} });
  db = migrate({ dbPath: join(root, "state.db"), backupsDir: join(root, "backups"), sources: [KERNEL_MIGRATIONS, SETTINGS_MIGRATIONS], clock, logger }).db;
  lines = [];
  service = createSettingsService({ store: createSettingsStore(db), clock, logger: createLogger({ level: "warn", clock, write: (line) => lines.push(line) }) });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("settings service", () => {
  it("reads nothing before the first write", () => {
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: null, revision: 0 });
  });

  it("stores a document per owner and key and bumps its revision", () => {
    expect(service.set(owner("u1"), { key: "appearance", value: appearance, baseRevision: 0 })).toEqual({ revision: 1 });
    expect(service.set(owner("u1"), { key: "appearance", value: { ...appearance, grid: false }, baseRevision: 1 })).toEqual({ revision: 2 });
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: { ...appearance, grid: false }, revision: 2 });
    expect(service.get(owner("u2"), "appearance")).toEqual({ value: null, revision: 0 });
    expect(service.get(owner("u1"), "keybindings")).toEqual({ value: null, revision: 0 });
  });

  it("a stale baseRevision is refused and the stored document is unchanged", () => {
    service.set(owner("u1"), { key: "appearance", value: appearance, baseRevision: 0 });
    expect(() => service.set(owner("u1"), { key: "appearance", value: { ...appearance, grid: false }, baseRevision: 0 })).toThrow(new PapError("conflict"));
    expect(() => service.set(owner("u1"), { key: "appearance", value: { ...appearance, grid: false }, baseRevision: 7 })).toThrow(new PapError("conflict"));
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: appearance, revision: 1 });
  });

  it("refuses a value over 128 KiB and stores nothing", () => {
    // "é" is two bytes in UTF-8 and one character for the schema's 256-character limit (M3-RT-08).
    const rules = Array.from({ length: 256 }, (_, i) => ({ key: "mod+k", command: `x.${"a".repeat(120)}${i}`, when: "é".repeat(256) }));
    expect(Buffer.byteLength(JSON.stringify(rules), "utf8")).toBeGreaterThan(MAX_SETTING_BYTES);
    expect(() => service.set(owner("u1"), { key: "keybindings", value: rules, baseRevision: 0 })).toThrow(new PapError("payload_too_large"));
    expect(service.get(owner("u1"), "keybindings")).toEqual({ value: null, revision: 0 });
  });

  it("reads a damaged row as no setting, logs the key, never the value, and lets the next write replace it", () => {
    db.run("INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ('u1', 'appearance', '{oops-secret', 3, 0)");
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: null, revision: 3 });
    expect(lines.join("\n")).toContain("settings_row_unreadable");
    expect(lines.join("\n")).not.toContain("oops-secret");
    expect(service.set(owner("u1"), { key: "appearance", value: appearance, baseRevision: 3 })).toEqual({ revision: 4 });
  });
});
```

`apps/daemon/src/daemon.settings.int.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [] });
});
afterEach(async () => {
  await t.stop();
});

describe("settings over /ws", () => {
  it("round-trips the account appearance, refuses a stale write and an invalid one", async () => {
    const client = await t.connect(await t.login());
    expect(await client.call("settings.get", { key: "appearance" })).toMatchObject({ ok: true, result: { value: null, revision: 0 } });
    const value = { mode: "night", darkTheme: "hc", lightTheme: "day", customThemes: [], uiFont: "manrope", monoFont: "system", uppercaseLabels: true, grid: false, railPosition: "left", avatarStyle: "outlined", toolDetail: "expanded" };
    expect(await client.call("settings.set", { key: "appearance", value, baseRevision: 0 } as never)).toMatchObject({ ok: true, result: { revision: 1 } });
    expect(await client.call("settings.get", { key: "appearance" })).toMatchObject({ ok: true, result: { value, revision: 1 } });
    expect(await client.call("settings.set", { key: "appearance", value: { ...value, grid: true }, baseRevision: 0 } as never)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await client.call("settings.set", { key: "appearance", value: { ...value, darkTheme: "nope" }, baseRevision: 1 } as never)).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await client.call("settings.get", { key: "appearance" })).toMatchObject({ ok: true, result: { value, revision: 1 } });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/contracts apps/daemon/src/modules/settings && pnpm test:int apps/daemon/src/daemon.settings.int.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`packages/contracts/src/settings.ts`:

```ts
import { z } from "zod";
import { defineMethod } from "./define.ts";

// Account-scope settings (DESIGN.md §13): validated here, on the server before a write and on the client before an
// import, so a stored document is always one the client can read back.
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const THEME_ROLES = ["bg", "surface", "text", "agent", "you", "attn", "ok", "err"] as const;
export const ThemeRoles = z.object({ bg: Hex, surface: Hex, text: Hex, agent: Hex, you: Hex, attn: Hex, ok: Hex, err: Hex });

/** Preset theme ids: a custom theme taking one would shadow the preset (M3-RT-09). */
export const PRESET_THEME_IDS = ["night", "day", "hc"] as const;

/** DESIGN.md §13.1: a custom theme edits roles, not variables. The id rule is T3's (themePalette.ts). */
export const CustomTheme = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,47}$/)
    .refine((id) => !(PRESET_THEME_IDS as readonly string[]).includes(id), "reserved theme id"),
  name: z.string().trim().min(1).max(64),
  base: z.enum(["night", "day"]),
  roles: ThemeRoles,
});
export type CustomTheme = z.infer<typeof CustomTheme>;

/**
 * Every field has a default (owner R3-4): a document written before a field existed reads with that field's
 * default, and the client parses field by field from this shape (Task 13).
 */
export const AccountAppearanceFields = z.object({
  mode: z.enum(["system", "night", "day"]).default("system"),
  /** "night", "hc" or the id of a custom theme on a night base. */
  darkTheme: z.string().min(1).max(48).default("night"),
  /** "day" or the id of a custom theme on a day base. */
  lightTheme: z.string().min(1).max(48).default("day"),
  customThemes: z.array(CustomTheme).max(16).default(() => []),
  uiFont: z.enum(["manrope", "system"]).default("manrope"),
  monoFont: z.enum(["jetbrains-mono", "system"]).default("jetbrains-mono"),
  uppercaseLabels: z.boolean().default(true),
  grid: z.boolean().default(true),
  railPosition: z.enum(["left", "right"]).default("left"),
  avatarStyle: z.enum(["outlined", "tinted", "glyph"]).default("outlined"),
  toolDetail: z.enum(["compact", "expanded", "full"]).default("compact"),
});

export const AccountAppearance = AccountAppearanceFields.superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const theme of value.customThemes) {
      if (ids.has(theme.id)) ctx.addIssue({ code: "custom", path: ["customThemes"], message: "duplicate theme id" });
      ids.add(theme.id);
    }
    const custom = (id: string, base: "night" | "day") => value.customThemes.some((t) => t.id === id && t.base === base);
    if (!(value.darkTheme === "night" || value.darkTheme === "hc" || custom(value.darkTheme, "night"))) {
      ctx.addIssue({ code: "custom", path: ["darkTheme"], message: "unknown dark theme" });
    }
    if (!(value.lightTheme === "day" || custom(value.lightTheme, "day"))) {
      ctx.addIssue({ code: "custom", path: ["lightTheme"], message: "unknown light theme" });
    }
  });
export type AccountAppearance = z.infer<typeof AccountAppearance>;

/** A user rule with this key unbinds the command's defaults (Task 16b merge rule). */
export const KEY_NONE = "none";

/** T3's keybinding rule shape ({key, command, when}); later rules win. */
export const KeybindingRule = z.object({
  key: z.string().min(1).max(64),
  command: z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,127}$/),
  when: z.string().min(1).max(256).optional(),
});
export type KeybindingRule = z.infer<typeof KeybindingRule>;
export const KeybindingRules = z.array(KeybindingRule).max(256);

export const SETTING_KEYS = ["appearance", "keybindings"] as const;
export const SettingKey = z.enum(SETTING_KEYS);
export type SettingKey = z.infer<typeof SettingKey>;
export const MAX_SETTING_BYTES = 131_072;

/** The revision the client read before this write; 0 creates the document (compare-and-set, owner R3-4). */
const BaseRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const SettingWrite = z.discriminatedUnion("key", [
  z.object({ key: z.literal("appearance"), value: AccountAppearance, baseRevision: BaseRevision }),
  z.object({ key: z.literal("keybindings"), value: KeybindingRules, baseRevision: BaseRevision }),
]);
export type SettingWrite = z.infer<typeof SettingWrite>;

export const settingsMethods = {
  "settings.get": defineMethod({
    name: "settings.get",
    permission: "settings:read",
    idempotent: true,
    params: z.object({ key: SettingKey }),
    result: z.object({ value: z.unknown().nullable(), revision: z.number().int().nonnegative() }),
    errors: [],
  }),
  "settings.set": defineMethod({
    name: "settings.set",
    permission: "settings:operate",
    idempotent: false,
    params: SettingWrite,
    result: z.object({ revision: z.number().int().positive() }),
    // conflict: the stored revision is not baseRevision any more; the client re-reads, merges and retries once.
    errors: ["payload_too_large", "conflict"],
  }),
} as const;
```

`permissions.ts`: `export const DOMAINS = ["system", "auth", "sessions", "settings"] as const;`

`methods.ts`: add `import { settingsMethods } from "./settings.ts";` and make the catalogue's first entry `...settingsMethods,` (first, so M2's additions at the end of the object never touch the same lines).

`index.ts`: add `export * from "./settings.ts";`.

`apps/daemon/src/modules/settings/migrations/202610111000_settings.sql`:

```sql
-- Account-scope settings (DESIGN.md §13): one JSON document per owner and key, validated against the contracts schema
-- before it is written. Device-scope settings (density, sizes, motion, chat width) never reach the server.
CREATE TABLE settings (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, key)
) STRICT;
```

`store.ts`:

```ts
import type { Db } from "../../kernel/db/database.ts";

export interface SettingRow {
  readonly value: string;
  readonly revision: number;
}

export interface SettingsStore {
  get(ownerId: string, key: string): SettingRow | undefined;
  /**
   * Compare-and-set in one statement: writes only when the stored revision is `baseRevision` (0 = no document yet)
   * and returns the new revision, or null when the document moved or appeared meanwhile (nothing is written then).
   */
  put(ownerId: string, key: string, value: string, baseRevision: number, now: number): number | null;
}

export function createSettingsStore(db: Db): SettingsStore {
  return {
    get: (ownerId, key) =>
      db.get<SettingRow>("SELECT value, revision FROM settings WHERE owner_id = $ownerId AND key = $key", { ownerId, key }),
    put: (ownerId, key, value, baseRevision, now) =>
      (baseRevision === 0
        ? db.get<{ revision: number }>(
            "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ($ownerId, $key, $value, 1, $now) " +
              "ON CONFLICT (owner_id, key) DO NOTHING RETURNING revision",
            { ownerId, key, value, now },
          )
        : db.get<{ revision: number }>(
            "UPDATE settings SET value = $value, revision = revision + 1, updated_at = $now " +
              "WHERE owner_id = $ownerId AND key = $key AND revision = $baseRevision RETURNING revision",
            { ownerId, key, value, now, baseRevision },
          )
      )?.revision ?? null,
  };
}
```

`service.ts`:

```ts
import { MAX_SETTING_BYTES, PapError, type Caller, type SettingKey, type SettingWrite } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { SettingsStore } from "./store.ts";

export interface SettingsService {
  get(caller: Caller, key: SettingKey): { value: unknown; revision: number };
  set(caller: Caller, write: SettingWrite): { revision: number };
}

export function createSettingsService(deps: { readonly store: SettingsStore; readonly clock: Clock; readonly logger: Logger }): SettingsService {
  return {
    get(caller, key) {
      const row = deps.store.get(caller.userId, key);
      if (!row) return { value: null, revision: 0 };
      try {
        return { value: JSON.parse(row.value) as unknown, revision: row.revision };
      } catch {
        // A damaged row reads as no setting: the client falls back to its defaults and the next write replaces it.
        deps.logger.warn("settings_row_unreadable", { key });
        return { value: null, revision: row.revision };
      }
    },
    set(caller, write) {
      const text = JSON.stringify(write.value);
      if (Buffer.byteLength(text, "utf8") > MAX_SETTING_BYTES) throw new PapError("payload_too_large");
      // Compare-and-set (owner R3-4): a write based on a revision that moved never lands over the newer copy.
      const revision = deps.store.put(caller.userId, write.key, text, write.baseRevision, deps.clock.now());
      if (revision === null) throw new PapError("conflict");
      return { revision };
    },
  };
}
```

`rpc.ts`:

```ts
import type { HandlerTable } from "@pap/contracts";
import type { SettingsService } from "./service.ts";

export type SettingsRpc = Pick<HandlerTable, "settings.get" | "settings.set">;

export function settingsRpc(service: SettingsService): SettingsRpc {
  return {
    "settings.get": async ({ key }, ctx) => service.get(ctx.caller, key),
    "settings.set": async (params, ctx) => service.set(ctx.caller, params),
  };
}
```

`index.ts`:

```ts
import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { settingsRpc, type SettingsRpc } from "./rpc.ts";
import { createSettingsService } from "./service.ts";
import { createSettingsStore } from "./store.ts";

export const SETTINGS_MIGRATIONS: MigrationSource = {
  module: "settings",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export interface SettingsModule {
  readonly rpc: SettingsRpc;
}

export function createSettingsModule(deps: { readonly db: Db; readonly clock: Clock; readonly logger: Logger }): SettingsModule {
  const logger = deps.logger.child({ module: "settings" });
  return { rpc: settingsRpc(createSettingsService({ store: createSettingsStore(deps.db), clock: deps.clock, logger })) };
}
```

`apps/daemon/src/daemon.ts`: import `{ createSettingsModule, SETTINGS_MIGRATIONS } from "./modules/settings/index.ts"`, add `SETTINGS_MIGRATIONS` to `sources`, create `const settings = createSettingsModule({ db, clock, logger });` after `sessions`, and build `handlers` as `{ ...systemHandlers(clock), ...sessions.rpc, ...settings.rpc }`. The service test imports `service.ts` and `store.ts` directly, which `docs/agents/sessions.md` allows for a module's own tests.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit packages/contracts apps/daemon && pnpm test:int apps/daemon/src/daemon.settings.int.test.ts && pnpm build && pnpm smoke`
Expected: PASS; `pnpm build` copies `modules/settings/migrations/*.sql` into `apps/daemon/dist` (copy-sql reads every `migrations` folder), and the smoke boots the built daemon with the new migration. Mutation checks: drop `AND revision = $baseRevision` → "a stale baseRevision is refused" fails; replace `DO NOTHING` by the M1-style upsert → the same test fails on its first case; remove the reserved-id refine → "refuses a custom theme that takes a preset's id" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/contracts apps/daemon
git commit -m "feat(settings): account-scope settings module with appearance and keybindings documents"
```

---

### Task 13: Appearance model — defaults, resolution, custom themes, contrast

Pure code, no DOM: what the two scopes hold, how they become `<html>` attributes and variables, how a custom theme's roles become the 31 tokens (DESIGN.md §13.2, with ADR 0012's three), WCAG contrast (DESIGN §12: the editor shows the ratio per role and asks below AA), and how an account document is read field by field and merged (owner R3-4, M3-RT-01).

**Files:**
- Create: `apps/web/src/features/appearance/model.ts`, `model.test.ts`, `derive.ts`, `derive.test.ts`, `contrast.ts`, `contrast.test.ts`
- Modify: `eslint.config.js` (`contrast.ts` and `derive.ts` join the `pap/no-raw-colors` `ignores`: colour math, pinned by their tests, M3-RT-02)

**Interfaces:**
- Consumes: `AccountAppearance`, `AccountAppearanceFields`, `CustomTheme` (Task 12); `THEME_TOKENS`, `ThemeToken`, `ThemeName`, `Density`, `DENSITIES` (Task 1a).
- Produces:
  - `DEFAULT_ACCOUNT: AccountAppearance`; `interface DeviceAppearance { density: Density; uiSize: number | null; chatSize: number | null; codeSize: number | null; motion: "system" | "reduced" | "none"; chatWidth: "full" | "wide" | "narrow" }`; `DEFAULT_DEVICE`; `SIZE_RANGES = { uiSize: [12, 16], chatSize: [13, 18], codeSize: [11, 16] }`; `DEVICE_KEY = "pap.appearance.device.v1"`; `ACCOUNT_CACHE_KEY = "pap.appearance.account.v1"`.
  - `parseAccount(value: unknown): AccountAppearance` (field by field: each field falls back on its own, `customThemes` keeps its valid entries, a side whose theme vanished falls back to its preset), `parseDevice(raw: string | null): DeviceAppearance`.
  - `changedAccountFields(previous: AccountAppearance, next: AccountAppearance): string[]`, `mergeAccount(server: AccountAppearance, local: AccountAppearance, dirty: ReadonlySet<string>): AccountAppearance` (the server copy with the local values of `dirty` laid over it, re-read by `parseAccount`).
  - `APPEARANCE_ATTRS = ["theme","density","font-ui","font-mono","labels","grid","rail","motion","chat-width","tool-detail","avatar"] as const`, `type AppearanceAttr`.
  - `interface ResolvedAppearance { attrs: Readonly<Record<AppearanceAttr, string>>; vars: Readonly<Record<string, string>> }`, `resolveAppearance(account, device, prefersLight: boolean): ResolvedAppearance`.
  - `interface BootSide { theme: ThemeName; vars: Readonly<Record<string, string>> }`, `interface BootCache { v: 1; mode: "system" | "night" | "day"; attrs: Readonly<Record<string, string>>; vars: Readonly<Record<string, string>>; dark: BootSide; light: BootSide }`, `toBootCache(account, device): BootCache`.
  - `deriveTheme(theme: CustomTheme): Readonly<Record<ThemeToken, string>>`, `tokenVars(tokens): Record<string, string>` (`--bg` → value).
  - `contrastRatio(foreground: string, background: string, backdrop?: string): number`, `mix(a: string, b: string, t: number): string`, `ensureContrast(color: string, background: string, target: number, toward: string): string`, `interface RoleCheck { role: string; ratio: number; passes: boolean; adjusted: string | null }`, `roleChecks(theme: CustomTheme): RoleCheck[]`.

**Rulings (pre-dispatch):**
- Mode chooses the side (Night / Day / System); a dark theme (Night Control, High contrast, or a custom theme on a night base) and a light theme (Day · Papier, or a custom theme on a day base) fill each side; High contrast is a dark-side choice (owner M3-Q2 confirmed). [M3R52]
- The derivation ratios (mixes of 8 %, 13 %, 22 %, 35 %, 38 %, 55 %, 58 %) are pap's own numbers for DESIGN §13.2's rules, documented in `docs/agents/web.md`. [M3R53]
- An account document is read field by field (owner R3-4): one bad or missing field never resets the others; `customThemes` keeps its valid entries (first of a duplicate id wins, at most 16, at most 64 entries examined); `darkTheme`/`lightTheme` fall back to `night`/`day` when their theme is gone or sits on the wrong side. `DEFAULT_ACCOUNT` equals the contracts' defaults (`AccountAppearance.parse({})`). [M3R54]
- A custom theme derives ADR 0012's tokens too: `control-border` and `focus-ring` (the you fill) are moved toward the text until they reach 3:1 on both bg and surface, `attn-title` until it reaches 4.5:1 on the attention tint over the surface. [M3R55]
- `contrast.ts` and `derive.ts` join the `pap/no-raw-colors` ignore list (they hold `#ffffff` as colour math); nothing else in `apps/web` does. [M3R5]

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/appearance/contrast.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { contrastRatio, ensureContrast, mix } from "./contrast.ts";

describe("WCAG contrast", () => {
  it("measures the known pairs", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#fb923c", "#faf9f6")).toBeCloseTo(2.15, 2); // R120: day focus ring
    expect(contrastRatio("#c2410c", "#faf9f6")).toBeCloseTo(4.92, 2);
  });

  it("composites a translucent background over its backdrop", () => {
    expect(contrastRatio("#ec4899", "#ec48991a", "#1a1724")).toBeCloseTo(4.48, 1); // R120: night approval title
  });

  it("mixes in sRGB and moves a colour toward a target until it passes", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    const fixed = ensureContrast("#fb923c", "#faf9f6", 4.5, "#1c1917");
    expect(contrastRatio(fixed, "#faf9f6")).toBeGreaterThanOrEqual(4.5);
  });
});
```

`apps/web/src/features/appearance/derive.test.ts`:

```ts
import type { CustomTheme } from "@pap/contracts";
import { THEME_TOKENS } from "@pap/ui";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast.ts";
import { deriveTheme, roleChecks, tokenVars } from "./derive.ts";

// DESIGN.md §13.1's example.
const example: CustomTheme = {
  id: "my-theme",
  name: "My theme",
  base: "night",
  roles: { bg: "#0E1626", surface: "#132033", agent: "#38BDF8", you: "#FB923C", attn: "#EC4899", ok: "#34D399", err: "#F87171", text: "#E6EDF7" },
};
const paper: CustomTheme = { ...example, id: "paper", base: "day", roles: { ...example.roles, bg: "#FFFDF8", surface: "#FFFFFF", text: "#1C1917", agent: "#A78BFA" } };
const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

describe("custom themes (DESIGN.md §13.2)", () => {
  it("derives every token, and only hex colours reach the token map", () => {
    const tokens = deriveTheme(example);
    expect(Object.keys(tokens).sort()).toEqual([...THEME_TOKENS].sort());
    for (const [name, value] of Object.entries(tokens)) expect(value, name).toMatch(HEX);
    expect(tokenVars(tokens)["--bg"]).toBe("#0e1626");
  });

  it("makes tints 10 % and lines 40 % (55 % for attention) of the fill", () => {
    const tokens = deriveTheme(example);
    expect([tokens["you-tint"], tokens["you-line"], tokens["attn-tint"], tokens["attn-line"]]).toEqual(["#fb923c1a", "#fb923c66", "#ec48991a", "#ec48998c"]);
  });

  it("darkens day text tones until they reach 4.5:1 on bg, and keeps the fill", () => {
    const tokens = deriveTheme(paper);
    expect(tokens["agent-fill"]).toBe("#a78bfa");
    expect(contrastRatio(tokens.agent, tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens["text-muted"], tokens.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("picks the ink with the better contrast on each fill", () => {
    const tokens = deriveTheme(example);
    expect(contrastRatio(tokens["you-ink"], tokens["you-fill"])).toBeGreaterThanOrEqual(4.5);
  });

  it("derives ADR 0012's tokens: 3:1 for the focus ring and control borders, 4.5:1 for the approval title on its card", () => {
    for (const theme of [example, paper]) {
      const t = deriveTheme(theme);
      for (const ground of [t.bg, t.surface]) {
        expect(contrastRatio(t["focus-ring"], ground), `${theme.id} focus on ${ground}`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(t["control-border"], ground), `${theme.id} control border on ${ground}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrastRatio(t["attn-title"], t["attn-tint"], t.surface), `${theme.id} approval title`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reports a role below AA so the editor can ask before saving", () => {
    const dim = { ...example, roles: { ...example.roles, text: "#1A2333" } };
    const checks = roleChecks(dim);
    expect(checks.find((c) => c.role === "text")?.passes).toBe(false);
    expect(roleChecks(example).every((c) => c.passes)).toBe(true);
  });
});
```

`apps/web/src/features/appearance/model.test.ts`:

```ts
import { AccountAppearance } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { changedAccountFields, DEFAULT_ACCOUNT, DEFAULT_DEVICE, mergeAccount, parseAccount, parseDevice, resolveAppearance, toBootCache } from "./model.ts";

const ocean = { id: "ocean", name: "Ocean", base: "night", roles: { bg: "#0E1626", surface: "#132033", text: "#E6EDF7", agent: "#38BDF8", you: "#FB923C", attn: "#EC4899", ok: "#34D399", err: "#F87171" } } as const;

describe("appearance model", () => {
  it("device settings parse fail-soft, field by field", () => {
    expect(parseDevice(null)).toEqual(DEFAULT_DEVICE);
    expect(parseDevice("{not json")).toEqual(DEFAULT_DEVICE);
    expect(parseDevice('{"density":"comfortable","uiSize":99,"motion":"none","extra":1}')).toEqual({ ...DEFAULT_DEVICE, density: "comfortable", motion: "none" });
  });

  it("DEFAULT_ACCOUNT is the contracts' defaults, and anything but an object reads as them", () => {
    expect(AccountAppearance.parse({})).toEqual(DEFAULT_ACCOUNT);
    for (const value of [null, undefined, 3, "x", [1]]) expect(parseAccount(value)).toEqual(DEFAULT_ACCOUNT);
  });

  it("a document missing one field keeps the others (owner R3-4)", () => {
    const older = Object.fromEntries(Object.entries({ ...DEFAULT_ACCOUNT, railPosition: "right", toolDetail: "full" }).filter(([name]) => name !== "grid"));
    expect(parseAccount(older)).toEqual({ ...DEFAULT_ACCOUNT, railPosition: "right", toolDetail: "full" });
  });

  it("a bad field falls back on its own", () => {
    expect(parseAccount({ ...DEFAULT_ACCOUNT, mode: "sepia", grid: "yes", railPosition: "right" })).toEqual({ ...DEFAULT_ACCOUNT, railPosition: "right" });
  });

  it("keeps the valid custom themes, drops the rest, and repairs a side whose theme is gone", () => {
    const account = parseAccount({ ...DEFAULT_ACCOUNT, customThemes: [ocean, { ...ocean, id: "day" }, { ...ocean, roles: { ...ocean.roles, bg: "red" } }, ocean], darkTheme: "ocean", lightTheme: "ocean" });
    expect(account.customThemes).toEqual([ocean]);
    expect([account.darkTheme, account.lightTheme]).toEqual(["ocean", "day"]);
    expect(parseAccount({ ...DEFAULT_ACCOUNT, darkTheme: "gone" }).darkTheme).toBe("night");
    // The cap: at most 16 custom themes survive, the first ones.
    const many = parseAccount({ ...DEFAULT_ACCOUNT, customThemes: Array.from({ length: 20 }, (_, i) => ({ ...ocean, id: `t${i}` })) });
    expect([many.customThemes.length, many.customThemes.at(-1)?.id]).toEqual([16, "t15"]);
  });

  it("names the changed fields and merges local changes over the server copy", () => {
    const local = { ...DEFAULT_ACCOUNT, grid: false, customThemes: [ocean], darkTheme: "ocean" };
    expect(changedAccountFields(DEFAULT_ACCOUNT, local).sort()).toEqual(["customThemes", "darkTheme", "grid"]);
    const server = { ...DEFAULT_ACCOUNT, railPosition: "right" } as const;
    expect(mergeAccount(server, local, new Set(["grid"]))).toEqual({ ...DEFAULT_ACCOUNT, railPosition: "right", grid: false });
    // The side points to a theme the server copy does not have: it falls back rather than naming nothing.
    expect(mergeAccount(server, local, new Set(["darkTheme"])).darkTheme).toBe("night");
  });

  it("follows the system by default and picks each side's theme", () => {
    expect(resolveAppearance(DEFAULT_ACCOUNT, DEFAULT_DEVICE, false).attrs.theme).toBe("night");
    expect(resolveAppearance(DEFAULT_ACCOUNT, DEFAULT_DEVICE, true).attrs.theme).toBe("day");
    expect(resolveAppearance({ ...DEFAULT_ACCOUNT, mode: "night" }, DEFAULT_DEVICE, true).attrs.theme).toBe("night");
    expect(resolveAppearance({ ...DEFAULT_ACCOUNT, darkTheme: "hc" }, DEFAULT_DEVICE, false).attrs.theme).toBe("hc");
  });

  it("sets a custom theme on its base with its tokens as variables, and device sizes as variables", () => {
    const resolved = resolveAppearance({ ...DEFAULT_ACCOUNT, customThemes: [ocean], darkTheme: "ocean" }, { ...DEFAULT_DEVICE, uiSize: 15 }, false);
    expect(resolved.attrs.theme).toBe("night");
    expect(resolved.vars["--bg"]).toBe("#0e1626");
    expect(resolved.vars["--size-ui"]).toBe("15px");
  });

  it("maps the account switches to attributes", () => {
    const { attrs } = resolveAppearance({ ...DEFAULT_ACCOUNT, uppercaseLabels: false, grid: false, railPosition: "right", uiFont: "system" }, DEFAULT_DEVICE, false);
    expect([attrs.labels, attrs.grid, attrs.rail, attrs["font-ui"]]).toEqual(["sentence", "off", "right", "system"]);
  });

  it("caches both sides for the boot script", () => {
    const cache = toBootCache({ ...DEFAULT_ACCOUNT, darkTheme: "hc" }, DEFAULT_DEVICE);
    expect([cache.v, cache.mode, cache.dark.theme, cache.light.theme]).toEqual([1, "system", "hc", "day"]);
    expect(cache.attrs).not.toHaveProperty("theme");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/appearance`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`contrast.ts`:

```ts
interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function parse(hex: string): Rgba {
  const value = hex.replace("#", "");
  const channel = (i: number) => parseInt(value.slice(i, i + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: value.length === 8 ? channel(6) / 255 : 1 };
}

const toHex = ({ r, g, b }: Rgba): string => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

/** sRGB interpolation from a to b; t = 0 is a, 1 is b. */
export function mix(a: string, b: string, t: number): string {
  const x = parse(a);
  const y = parse(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t, a: 1 });
}

function over(color: Rgba, backdrop: Rgba): Rgba {
  return { r: color.r * color.a + backdrop.r * (1 - color.a), g: color.g * color.a + backdrop.g * (1 - color.a), b: color.b * color.a + backdrop.b * (1 - color.a), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.x contrast ratio. A translucent background is composited over `backdrop` (default white). */
export function contrastRatio(foreground: string, background: string, backdrop = "#ffffff"): number {
  const bg = over(parse(background), parse(backdrop));
  const fg = over(parse(foreground), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Moves `color` toward `toward` in 5 % steps until it reaches `target` on `background` (DESIGN.md §13.2). */
export function ensureContrast(color: string, background: string, target: number, toward: string): string {
  let current = toHex(parse(color));
  for (let step = 1; step <= 20 && contrastRatio(current, background) < target; step++) current = mix(color, toward, step / 20);
  return current;
}
```

`derive.ts`:

```ts
import type { CustomTheme } from "@pap/contracts";
import type { ThemeToken } from "@pap/ui";
import { contrastRatio, ensureContrast, mix } from "./contrast.ts";

const AA = 4.5;
const NON_TEXT = 3;
const lower = (hex: string) => hex.toLowerCase();

/** DESIGN.md §13.2: shades, inks and day text tones derived from the eight roles. Inputs are validated hex colours. */
export function deriveTheme(theme: CustomTheme): Readonly<Record<ThemeToken, string>> {
  const r = Object.fromEntries(Object.entries(theme.roles).map(([k, v]) => [k, lower(v)])) as CustomTheme["roles"];
  const night = theme.base === "night";
  const tone = (role: string) => ensureContrast(role, r.bg, AA, r.text);
  // ADR 0012 / WCAG 1.4.11: 3:1 against both grounds a control or a focus ring sits on.
  const nonText = (color: string) => ensureContrast(ensureContrast(color, r.bg, NON_TEXT, r.text), r.surface, NON_TEXT, r.text);
  const darkInk = night ? r.bg : r.text;
  const ink = (fill: string) => (contrastRatio("#ffffff", fill) >= contrastRatio(darkInk, fill) ? "#ffffff" : darkInk);
  return {
    bg: r.bg,
    "bg-side": mix(r.bg, r.surface, 0.35),
    surface: r.surface,
    "surface-2": mix(r.surface, r.text, 0.08),
    border: mix(r.bg, r.text, 0.13),
    "border-strong": mix(r.bg, r.text, 0.22),
    text: r.text,
    "text-muted": ensureContrast(mix(r.text, r.bg, 0.38), r.bg, AA, r.text),
    "text-dim": mix(r.text, r.bg, 0.58),
    grid: `${r.text}${night ? "06" : "0a"}`,
    agent: tone(r.agent),
    "agent-fill": r.agent,
    "agent-ink": ink(r.agent),
    you: tone(r.you),
    "you-fill": r.you,
    "you-ink": ink(r.you),
    "you-tint": `${r.you}1a`,
    "you-line": `${r.you}66`,
    "you-text": ensureContrast(mix(r.you, r.text, 0.55), r.bg, AA, r.text),
    "control-border": nonText(mix(r.bg, r.text, 0.38)),
    "focus-ring": nonText(r.you),
    "attn-title": ensureContrast(r.attn, mix(r.surface, r.attn, 26 / 255), AA, r.text),
    attn: tone(r.attn),
    "attn-fill": r.attn,
    "attn-ink": ink(r.attn),
    "attn-tint": `${r.attn}1a`,
    "attn-line": `${r.attn}8c`,
    ok: tone(r.ok),
    err: tone(r.err),
    "diff-add": `${r.ok}14`,
    "diff-del": `${r.err}14`,
  };
}

export const tokenVars = (tokens: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(tokens).map(([name, value]) => [`--${name}`, value]));

export interface RoleCheck {
  readonly role: string;
  readonly ratio: number;
  readonly passes: boolean;
  /** The tone the theme uses instead of the role, when derivation had to move it. */
  readonly adjusted: string | null;
}

/** DESIGN.md §12: the ratio per role (text tones on bg and surface, fills under their ink). */
export function roleChecks(theme: CustomTheme): RoleCheck[] {
  const t = deriveTheme(theme);
  const text = (role: string, token: ThemeToken): RoleCheck => {
    const ratio = Math.min(contrastRatio(t[token], t.bg), contrastRatio(t[token], t.surface));
    const original = lower(theme.roles[role as keyof CustomTheme["roles"]]);
    return { role, ratio, passes: ratio >= AA, adjusted: t[token] === original ? null : t[token] };
  };
  const fill = (role: "agent" | "you" | "attn"): RoleCheck => {
    const ratio = contrastRatio(t[`${role}-ink`], t[`${role}-fill`]);
    return { role: `${role}-fill`, ratio, passes: ratio >= AA, adjusted: null };
  };
  return [text("text", "text"), text("agent", "agent"), text("you", "you"), text("attn", "attn"), text("ok", "ok"), text("err", "err"), fill("agent"), fill("you"), fill("attn")];
}
```

`model.ts`:

```ts
import { AccountAppearanceFields, CustomTheme, type AccountAppearance } from "@pap/contracts";
import { DENSITIES, type Density, type ThemeName } from "@pap/ui";
import { deriveTheme, tokenVars } from "./derive.ts";

export const DEVICE_KEY = "pap.appearance.device.v1";
export const ACCOUNT_CACHE_KEY = "pap.appearance.account.v1";

export const DEFAULT_ACCOUNT: AccountAppearance = {
  mode: "system",
  darkTheme: "night",
  lightTheme: "day",
  customThemes: [],
  uiFont: "manrope",
  monoFont: "jetbrains-mono",
  uppercaseLabels: true,
  grid: true,
  railPosition: "left",
  avatarStyle: "outlined",
  toolDetail: "compact",
};

export interface DeviceAppearance {
  readonly density: Density;
  /** px; null follows the density. */
  readonly uiSize: number | null;
  readonly chatSize: number | null;
  readonly codeSize: number | null;
  readonly motion: "system" | "reduced" | "none";
  /** Default full width (pi-web rejected a 72ch cap, decision 28). */
  readonly chatWidth: "full" | "wide" | "narrow";
}

export const DEFAULT_DEVICE: DeviceAppearance = { density: "compact", uiSize: null, chatSize: null, codeSize: null, motion: "system", chatWidth: "full" };
export const SIZE_RANGES = { uiSize: [12, 16], chatSize: [13, 18], codeSize: [11, 16] } as const;

const MAX_CUSTOM_THEMES = 16;
const MAX_THEME_ENTRIES_READ = 64;

/**
 * Field by field (owner R3-4, M3-RT-01): an unreadable or missing field falls back on its own; custom themes keep
 * their valid entries; a side whose theme is gone falls back to its preset. Never throws.
 */
export function parseAccount(value: unknown): AccountAppearance {
  const source: Readonly<Record<string, unknown>> = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const field = <K extends keyof AccountAppearance>(name: K): AccountAppearance[K] => {
    const parsed = AccountAppearanceFields.shape[name].safeParse(source[name]);
    return parsed.success ? (parsed.data as AccountAppearance[K]) : DEFAULT_ACCOUNT[name];
  };
  const themes: CustomTheme[] = [];
  const ids = new Set<string>();
  const entries: readonly unknown[] = Array.isArray(source.customThemes) ? source.customThemes.slice(0, MAX_THEME_ENTRIES_READ) : [];
  for (const entry of entries) {
    const parsed = CustomTheme.safeParse(entry);
    if (!parsed.success || ids.has(parsed.data.id) || themes.length === MAX_CUSTOM_THEMES) continue;
    ids.add(parsed.data.id);
    themes.push(parsed.data);
  }
  const side = (id: string, base: CustomTheme["base"], presets: readonly string[], fallback: string): string =>
    presets.includes(id) || themes.some((theme) => theme.id === id && theme.base === base) ? id : fallback;
  return {
    mode: field("mode"),
    darkTheme: side(field("darkTheme"), "night", ["night", "hc"], "night"),
    lightTheme: side(field("lightTheme"), "day", ["day"], "day"),
    customThemes: themes,
    uiFont: field("uiFont"),
    monoFont: field("monoFont"),
    uppercaseLabels: field("uppercaseLabels"),
    grid: field("grid"),
    railPosition: field("railPosition"),
    avatarStyle: field("avatarStyle"),
    toolDetail: field("toolDetail"),
  };
}

/** The account fields whose value differs (themes compared as JSON: they are plain data). */
export function changedAccountFields(previous: AccountAppearance, next: AccountAppearance): string[] {
  return (Object.keys(next) as Array<keyof AccountAppearance>).filter((name) => JSON.stringify(previous[name]) !== JSON.stringify(next[name]));
}

/** The server copy with the local values of the fields changed on this device laid over it, re-read field by field. */
export function mergeAccount(server: AccountAppearance, local: AccountAppearance, dirty: ReadonlySet<string>): AccountAppearance {
  const merged: Record<string, unknown> = { ...server };
  for (const name of dirty) if (name in local) merged[name] = local[name as keyof AccountAppearance];
  return parseAccount(merged);
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
const size = (value: unknown, [min, max]: readonly [number, number]): number | null => (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null);

/** Field by field: one bad field never resets the others (Review Focus 1). */
export function parseDevice(raw: string | null): DeviceAppearance {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
  } catch {
    value = {};
  }
  return {
    density: oneOf(value.density, DENSITIES, DEFAULT_DEVICE.density),
    uiSize: size(value.uiSize, SIZE_RANGES.uiSize),
    chatSize: size(value.chatSize, SIZE_RANGES.chatSize),
    codeSize: size(value.codeSize, SIZE_RANGES.codeSize),
    motion: oneOf(value.motion, ["system", "reduced", "none"] as const, DEFAULT_DEVICE.motion),
    chatWidth: oneOf(value.chatWidth, ["full", "wide", "narrow"] as const, DEFAULT_DEVICE.chatWidth),
  };
}

export const APPEARANCE_ATTRS = ["theme", "density", "font-ui", "font-mono", "labels", "grid", "rail", "motion", "chat-width", "tool-detail", "avatar"] as const;
export type AppearanceAttr = (typeof APPEARANCE_ATTRS)[number];

export interface ResolvedAppearance {
  readonly attrs: Readonly<Record<AppearanceAttr, string>>;
  readonly vars: Readonly<Record<string, string>>;
}

function side(account: AccountAppearance, light: boolean): { theme: ThemeName; vars: Record<string, string> } {
  const id = light ? account.lightTheme : account.darkTheme;
  const custom = account.customThemes.find((theme) => theme.id === id);
  if (custom) return { theme: custom.base, vars: tokenVars(deriveTheme(custom)) };
  return { theme: id === "hc" ? "hc" : light ? "day" : "night", vars: {} };
}

function deviceVars(device: DeviceAppearance): Record<string, string> {
  const vars: Record<string, string> = {};
  if (device.uiSize !== null) vars["--size-ui"] = `${device.uiSize}px`;
  if (device.chatSize !== null) vars["--size-chat"] = `${device.chatSize}px`;
  if (device.codeSize !== null) vars["--size-code"] = `${device.codeSize}px`;
  return vars;
}

function plainAttrs(account: AccountAppearance, device: DeviceAppearance): Omit<Record<AppearanceAttr, string>, "theme"> {
  return {
    density: device.density,
    "font-ui": account.uiFont === "system" ? "system" : "default",
    "font-mono": account.monoFont === "system" ? "system" : "default",
    labels: account.uppercaseLabels ? "upper" : "sentence",
    grid: account.grid ? "on" : "off",
    rail: account.railPosition,
    motion: device.motion,
    "chat-width": device.chatWidth,
    "tool-detail": account.toolDetail,
    avatar: account.avatarStyle,
  };
}

export function resolveAppearance(account: AccountAppearance, device: DeviceAppearance, prefersLight: boolean): ResolvedAppearance {
  const light = account.mode === "day" || (account.mode === "system" && prefersLight);
  const { theme, vars } = side(account, light);
  return { attrs: { theme, ...plainAttrs(account, device) }, vars: { ...vars, ...deviceVars(device) } };
}

export interface BootSide {
  readonly theme: ThemeName;
  readonly vars: Readonly<Record<string, string>>;
}

export interface BootCache {
  readonly v: 1;
  readonly mode: AccountAppearance["mode"];
  readonly attrs: Readonly<Record<string, string>>;
  readonly vars: Readonly<Record<string, string>>;
  readonly dark: BootSide;
  readonly light: BootSide;
}

/** What the boot script replays before the first paint: both sides, so "system" resolves without the app. */
export function toBootCache(account: AccountAppearance, device: DeviceAppearance): BootCache {
  return { v: 1, mode: account.mode, attrs: plainAttrs(account, device), vars: deviceVars(device), dark: side(account, false), light: side(account, true) };
}
```

- [ ] **Step 4: Run the tests**

In `eslint.config.js`, append `"apps/web/src/features/appearance/contrast.ts"` and `"apps/web/src/features/appearance/derive.ts"` to the `pap/no-raw-colors` block's `ignores` (after `presets.ts`, under the same comment).

Run: `pnpm test:unit apps/web/src/features/appearance && pnpm lint`
Expected: PASS. Mutation checks: make `parseAccount` return `DEFAULT_ACCOUNT` when any field fails (the M1-era `safeParse` shape) → "a document missing one field keeps the others" and "a bad field falls back on its own" fail; drop the `side()` repair → "repairs a side whose theme is gone" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/features/appearance eslint.config.js
git commit -m "feat(appearance): account and device model, field-wise parse and merge, theme derivation and contrast"
```

---

### Task 14: Pre-paint boot script, the Vite plugin that ships it, and the applier

DESIGN.md §14: "applied as `data-*` attributes before first paint to avoid a flash". T3 does it with a large inline script in `index.html` (`apps/web/index.html:12-345`); our CSP has no `'unsafe-inline'` for scripts (R74), so the boot script is an external classic script, hashed under `/assets/`, linked first in `<head>` by a small Vite plugin. It replays a cache the app writes (`toBootCache`), so it never duplicates the resolution logic (T3 keeps a deliberate copy; we avoid it). It is plain JS, not a stringified function (a bundler-injected helper such as esbuild's `__name` would break a `Function#toString` copy). The applier swaps the theme without transitions for two frames (Orca `src/renderer/src/lib/document-theme.ts`).

**Files:**
- Create: `apps/web/src/features/appearance/boot-script.js`, `boot-script.test.ts`, `apply.ts`, `apply.test.ts`
- Create: `apps/web/vite/appearance-boot.ts`
- Modify: `apps/web/vite.config.ts`, `apps/web/src/vite-config.test.ts`, `apps/web/src/build-output.int.test.ts`, `apps/web/tsconfig.json` (include `vite`), `eslint.config.js` (browser globals for `apps/web/src/**/*.js`), `knip.json` (the boot script is read as a file)

**Interfaces:**
- Consumes: `BootCache`, `ResolvedAppearance`, `APPEARANCE_ATTRS` (Task 13).
- Produces:
  - `BOOT_KEY = "pap.appearance.boot"` (exported from `apply.ts`; the script reads the same literal).
  - `BOOT_VAR_NAMES: ReadonlySet<string>` (every `--<THEME_TOKENS>` plus `--size-ui`, `--size-chat`, `--size-code`: the only custom properties the appearance writes inline; the script carries the same list, pinned by a test), `inlineAppearanceVars(root: HTMLElement): Set<string>` (those of them already set inline).
  - `interface Frames { request(fn: () => void): number; cancel(id: number): void }`, `applyAppearance(root: HTMLElement, resolved: ResolvedAppearance, previousVars: ReadonlySet<string>, frames?: Frames): Set<string>`, `writeBootCache(storage: Pick<Storage, "setItem">, cache: BootCache): boolean` (false and `reportClientIssue("boot_cache_refused")` when storage refuses), `syncThemeColor(root: HTMLElement, doc?: Document): void`.
  - Vite plugin `appearanceBoot(): Plugin` (name `pap-appearance-boot`).

**Rulings (pre-dispatch):**
- The plugin relies on Vite 8 keeping `transformIndexHtml` tag injection and `emitFile` in `generateBundle`; the build-output test pins both. [M3R56]
- The boot script sets only the custom properties of `BOOT_VAR_NAMES` (hex or px values) and only the known `data-*` attributes (plain words); the controller's first apply starts from the appearance variables already inline, so a boot-set variable the app no longer resolves is removed (M3-RT-11). Other inline variables (`--app-viewport-height`) are never touched by either. [M3R57]
- The script uses optional catch bindings (`catch {`, ES2019, inside the Safari 16.4 floor), so no unused binding trips ESLint (M3-RT-12). [M3R58]
- Reviewed by Opus (owner X2): it runs before the app under the strict CSP and turns untrusted `localStorage` into attributes and style properties. [M3R59]

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/appearance/boot-script.test.ts`:

```ts
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_KEY, BOOT_VAR_NAMES } from "./apply.ts";

const source = readFileSync(new URL("./boot-script.js", import.meta.url), "utf8");
const run = () => new Function(source)();
const root = document.documentElement;

function setLight(light: boolean) {
  window.matchMedia = ((query: string) => ({ matches: light && query.includes("light"), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  for (const name of [...root.getAttributeNames()]) if (name.startsWith("data-")) root.removeAttribute(name);
  root.removeAttribute("style");
  setLight(false);
});
afterEach(() => localStorage.clear());

describe("boot script (runs before the first paint)", () => {
  it("reads the same storage key the applier writes", () => {
    expect(source).toContain(JSON.stringify(BOOT_KEY));
  });

  it("replays attributes, variables and the side the system asks for", () => {
    localStorage.setItem(BOOT_KEY, JSON.stringify({ v: 1, mode: "system", attrs: { density: "comfortable", labels: "sentence" }, vars: { "--size-ui": "15px" }, dark: { theme: "hc", vars: {} }, light: { theme: "night", vars: { "--bg": "#0e1626" } } }));
    run();
    expect([root.dataset.density, root.dataset.labels, root.dataset.theme, root.style.getPropertyValue("--size-ui")]).toEqual(["comfortable", "sentence", "hc", "15px"]);
    setLight(true);
    run();
    expect([root.dataset.theme, root.style.getPropertyValue("--bg")]).toEqual(["night", "#0e1626"]);
  });

  it("carries exactly the variable names the app writes", () => {
    const listed = /var allowed = "([^"]+)"/.exec(source)?.[1]?.split(" ") ?? [];
    expect(listed.map((name) => `--${name}`).sort()).toEqual([...BOOT_VAR_NAMES].sort());
  });

  it("ignores garbage, unknown keys, unknown variables and throwing storage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(BOOT_KEY, "{oops");
    expect(run).not.toThrow();
    expect(warn).toHaveBeenCalledWith("pap: appearance_boot_failed");
    warn.mockRestore();
    localStorage.setItem(BOOT_KEY, JSON.stringify({ v: 1, mode: "night", attrs: { onclick: "x", density: "<b>" }, vars: { "--bg": "url(https://x.test)", "color": "red", "--app-viewport-height": "1px", "--rail-w": "1px" }, dark: { theme: "evil", vars: {} }, light: { theme: "day", vars: {} } }));
    run();
    expect(root.getAttribute("data-onclick")).toBeNull();
    expect(root.dataset.density).toBeUndefined();
    expect(root.dataset.theme).toBeUndefined();
    expect(root.getAttribute("style") ?? "").toBe("");
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("denied");
    };
    expect(run).not.toThrow();
    Storage.prototype.getItem = getItem;
  });
});
```

`apps/web/src/features/appearance/apply.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { applyAppearance, BOOT_KEY, inlineAppearanceVars, writeBootCache } from "./apply.ts";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE, resolveAppearance, toBootCache } from "./model.ts";

const frames = () => {
  const queue: Array<() => void> = [];
  return { request: (fn: () => void) => queue.push(fn), cancel: vi.fn(), flush: () => queue.splice(0).forEach((fn) => fn()), queue };
};

describe("applyAppearance", () => {
  it("sets every attribute, swaps variables and lifts the transition guard two frames later", () => {
    const root = document.createElement("html");
    const f = frames();
    const first = applyAppearance(root, resolveAppearance(DEFAULT_ACCOUNT, { ...DEFAULT_DEVICE, uiSize: 15 }, false), new Set(), f);
    expect([root.dataset.theme, root.dataset.density, root.style.getPropertyValue("--size-ui")]).toEqual(["night", "compact", "15px"]);
    expect(root.classList.contains("theme-swap")).toBe(true);
    f.flush();
    f.flush();
    expect(root.classList.contains("theme-swap")).toBe(false);
    applyAppearance(root, resolveAppearance(DEFAULT_ACCOUNT, DEFAULT_DEVICE, false), first, f);
    expect(root.style.getPropertyValue("--size-ui")).toBe("");
  });

  it("finds the appearance variables already set inline, and only those", () => {
    const root = document.createElement("html");
    root.style.setProperty("--bg", "#000000");
    root.style.setProperty("--size-ui", "15px");
    root.style.setProperty("--app-viewport-height", "400px");
    expect([...inlineAppearanceVars(root)].sort()).toEqual(["--bg", "--size-ui"]);
  });

  it("writes the boot cache and survives a storage that refuses", () => {
    const stored: Record<string, string> = {};
    writeBootCache({ setItem: (k, v) => void (stored[k] = v) }, toBootCache(DEFAULT_ACCOUNT, DEFAULT_DEVICE));
    expect(JSON.parse(stored[BOOT_KEY] ?? "{}").v).toBe(1);
    expect(writeBootCache({ setItem: () => { throw new Error("quota"); } }, toBootCache(DEFAULT_ACCOUNT, DEFAULT_DEVICE))).toBe(false);
  });
});
```

Append to `apps/web/src/vite-config.test.ts`:

```ts
describe("appearance boot plugin", () => {
  it("links one hashed classic script first in <head>, under /assets/ in a build", async () => {
    const config = await load();
    const plugin = (config.plugins ?? []).flat().find((p) => p && typeof p === "object" && "name" in p && p.name === "pap-appearance-boot") as { transformIndexHtml(html: string): unknown; configResolved(c: { command: string }): void };
    plugin.configResolved({ command: "build" });
    const tags = plugin.transformIndexHtml("<html></html>") as Array<{ tag: string; attrs: { src: string; type?: string }; injectTo: string }>;
    expect(tags).toHaveLength(1);
    expect(tags[0]?.tag).toBe("script");
    expect(tags[0]?.attrs.src).toMatch(/^\/assets\/appearance-boot-[0-9a-f]{10}\.js$/);
    expect(tags[0]?.attrs.type).toBeUndefined();
    expect(tags[0]?.injectTo).toBe("head-prepend");
  });
});
```

Append to `apps/web/src/build-output.int.test.ts`:

```ts
  it("runs the appearance boot script before anything else, as a blocking external file (R74)", async () => {
    const head = html.slice(0, html.indexOf("</head>"));
    const first = /<script\b([^>]*)>/.exec(head);
    expect(first?.[1]).toMatch(/src="\/assets\/appearance-boot-[0-9a-f]{10}\.js"/);
    expect(first?.[1]).not.toMatch(/type="module"|defer|async/);
    const file = /src="\/assets\/(appearance-boot-[0-9a-f]{10}\.js)"/.exec(head)?.[1] ?? "";
    expect(await readFile(join(out, "assets", file), "utf8")).toContain('"pap.appearance.boot"');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/appearance apps/web/src/vite-config.test.ts && pnpm test:int apps/web/src/build-output.int.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/features/appearance/boot-script.js`:

```js
// Runs as a blocking classic script before the first paint. vite/appearance-boot.ts emits it under /assets/ and links
// it first in <head>: the CSP has no 'unsafe-inline' for scripts (R74). It replays what apply.ts last wrote to
// localStorage "pap.appearance.boot" and ignores anything unexpected: only known attributes with plain word values,
// only the custom properties the app writes (apply.ts BOOT_VAR_NAMES) with hex or px values. ES2019 (optional catch
// binding), no imports; any failure leaves the defaults of tokens.css.
(function () {
  try {
    var raw = window.localStorage.getItem("pap.appearance.boot");
    if (!raw) return;
    var cache = JSON.parse(raw);
    if (!cache || cache.v !== 1) return;
    var root = document.documentElement;
    var names = ["density", "font-ui", "font-mono", "labels", "grid", "rail", "motion", "chat-width", "tool-detail", "avatar"];
    // apply.ts BOOT_VAR_NAMES without the leading "--" (boot-script.test.ts proves the two lists are equal).
    var allowed = "bg bg-side surface surface-2 border border-strong control-border text text-muted text-dim grid focus-ring agent agent-fill agent-ink you you-fill you-ink you-tint you-line you-text attn attn-fill attn-ink attn-tint attn-line attn-title ok err diff-add diff-del size-ui size-chat size-code".split(" ");
    var word = /^[a-z0-9-]{1,32}$/;
    var varValue = /^(#[0-9a-f]{6}([0-9a-f]{2})?|\d{1,2}(\.\d{1,2})?px)$/i;
    var setVars = function (vars) {
      if (!vars || typeof vars !== "object") return;
      Object.keys(vars).forEach(function (name) {
        var value = vars[name];
        var known = name.slice(0, 2) === "--" && allowed.indexOf(name.slice(2)) !== -1;
        if (known && typeof value === "string" && varValue.test(value)) root.style.setProperty(name, value);
      });
    };
    var attrs = cache.attrs && typeof cache.attrs === "object" ? cache.attrs : {};
    names.forEach(function (name) {
      var value = attrs[name];
      if (typeof value === "string" && word.test(value)) root.setAttribute("data-" + name, value);
    });
    setVars(cache.vars);
    var light = cache.mode === "day" || (cache.mode === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
    var side = light ? cache.light : cache.dark;
    if (side && (side.theme === "night" || side.theme === "day" || side.theme === "hc")) {
      root.setAttribute("data-theme", side.theme);
      setVars(side.vars);
    }
  } catch {
    // The defaults of tokens.css apply; the app rewrites the cache once it starts.
    if (typeof console !== "undefined") console.warn("pap: appearance_boot_failed");
  }
})();
```

`apps/web/src/features/appearance/apply.ts`:

```ts
import { THEME_TOKENS } from "@pap/ui";
import { reportClientIssue } from "../../lib/report.ts";
import { APPEARANCE_ATTRS, type BootCache, type ResolvedAppearance } from "./model.ts";

export const BOOT_KEY = "pap.appearance.boot";

/** The only custom properties the appearance writes inline: a custom theme's tokens and the device sizes. */
export const BOOT_VAR_NAMES: ReadonlySet<string> = new Set([...THEME_TOKENS.map((name) => `--${name}`), "--size-ui", "--size-chat", "--size-code"]);

/**
 * The appearance variables already inline (set by the boot script), so the first apply removes those the app no
 * longer resolves (M3-RT-11). Other inline variables, such as --app-viewport-height, are not the appearance's.
 */
export function inlineAppearanceVars(root: HTMLElement): Set<string> {
  const names = new Set<string>();
  for (const declaration of root.style.cssText.split(";")) {
    const name = declaration.slice(0, declaration.indexOf(":")).trim();
    if (BOOT_VAR_NAMES.has(name)) names.add(name);
  }
  return names;
}

export interface Frames {
  request(fn: () => void): number;
  cancel(id: number): void;
}

const WINDOW_FRAMES: Frames = { request: (fn) => window.requestAnimationFrame(fn), cancel: (id) => window.cancelAnimationFrame(id) };
let pending: number[] = [];

/**
 * Applies a resolved appearance to <html>. Transitions are off for two frames so a theme change never fades in
 * steps (Orca applyDocumentTheme); a rapid second change cancels the first one's frames. Returns the variables set,
 * for the next call to remove what it no longer sets.
 */
export function applyAppearance(root: HTMLElement, resolved: ResolvedAppearance, previousVars: ReadonlySet<string>, frames: Frames = WINDOW_FRAMES): Set<string> {
  root.classList.add("theme-swap");
  for (const name of APPEARANCE_ATTRS) root.setAttribute(`data-${name}`, resolved.attrs[name]);
  for (const name of previousVars) if (!(name in resolved.vars)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(resolved.vars)) root.style.setProperty(name, value);
  pending.forEach((id) => frames.cancel(id));
  pending = [];
  pending.push(
    frames.request(() => {
      pending.push(frames.request(() => root.classList.remove("theme-swap")));
    }),
  );
  return new Set(Object.keys(resolved.vars));
}

/** False in private mode or with a full quota: the next load paints the defaults first, then the app applies. */
export function writeBootCache(storage: Pick<Storage, "setItem">, cache: BootCache): boolean {
  try {
    storage.setItem(BOOT_KEY, JSON.stringify(cache));
    return true;
  } catch {
    reportClientIssue("boot_cache_refused");
    return false;
  }
}

/** The browser chrome follows the side bar colour (T3 syncBrowserChromeTheme). */
export function syncThemeColor(root: HTMLElement, doc: Document = document): void {
  const color = getComputedStyle(root).getPropertyValue("--bg-side").trim();
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta && /^#[0-9a-f]{6}$/i.test(color)) meta.setAttribute("content", color);
}
```

`apps/web/vite/appearance-boot.ts`:

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const SOURCE = new URL("../src/features/appearance/boot-script.js", import.meta.url);
const DEV_PATH = "/@pap/appearance-boot.js";

/**
 * Ships the appearance boot script as a hashed classic script linked first in <head> (DESIGN.md §14, R74). The tag is
 * added after Vite's own HTML processing (no `order: "pre"`), so Vite never tries to bundle a non-module script.
 */
export function appearanceBoot(): Plugin {
  const source = readFileSync(SOURCE, "utf8");
  const fileName = `assets/appearance-boot-${createHash("sha256").update(source).digest("hex").slice(0, 10)}.js`;
  let command = "build";
  return {
    name: "pap-appearance-boot",
    configResolved(config) {
      command = config.command;
    },
    configureServer(server) {
      server.middlewares.use(DEV_PATH, (_request, response) => {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        response.end(source);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName, source });
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { src: command === "serve" ? DEV_PATH : `/${fileName}` }, injectTo: "head-prepend" }];
    },
  };
}
```

`apps/web/vite.config.ts`: `import { appearanceBoot } from "./vite/appearance-boot.ts";` and `plugins: [appearanceBoot(), react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()]`. `apps/web/tsconfig.json` `include` gains `"vite"`.

`eslint.config.js`: add a block `{ files: ["apps/web/src/**/*.js"], languageOptions: { globals: { ...globals.browser } } }`.

`knip.json`: in a new `"apps/web"` workspace entry, `"entry": ["src/features/appearance/boot-script.js", "vite/*.ts"]`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm test:int apps/web/src/build-output.int.test.ts && pnpm lint && pnpm knip`
Expected: PASS; the existing "has no inline script" case still passes (both scripts have a `src` under `/assets/`). Mutation checks: drop the `known` condition in `setVars` → "ignores … unknown variables" fails; add a name to the script's list only → "carries exactly the variable names the app writes" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web eslint.config.js knip.json
git commit -m "feat(appearance): pre-paint boot script shipped as a hashed classic script, and the applier"
```

---

### Task 15: Appearance store, controller and account sync (compare-and-set)

The store holds both scopes; the controller applies them at start and follows the system theme; the account scope is one **account document** kept in step with the server by compare-and-set (owner R3-4, M3-RT-01, the Critical finding of the red-team): nothing is sent before the first load settles, nothing after a failed load until a later one succeeds, one save at a time from the latest revision, a `conflict` re-reads, merges the fields changed on this device and retries once, and a re-sync keeps a waiting change instead of dropping it. The engine (`createAccountDocument`) lives in `apps/web/src/lib/` because Task 17b's keybindings use it too. The shell calls `syncAccountAppearance` each time the socket opens (Task 19b). A daemon without `settings.get` (an older build: `unknown_method`) leaves the local values in place without a message and receives no save. No client call here gets its own deadline: the runtime settles every call when the socket is declared dead (spec C §4.2, 15 s); a save that ends in `timeout`/`connection_lost` is never re-sent by itself (R105): the next change, or the next sync's fresh read, sends it.

**Files:**
- Create: `apps/web/src/lib/account-setting.ts`, `apps/web/src/lib/account-setting.test.ts`
- Create: `apps/web/src/features/appearance/appearance-store.ts`, `controller.ts`, `controller.test.ts`, `index.ts`
- Modify: `apps/web/src/main.tsx` (start the controller before the first render), `eslint.config.js` (`web-root` may import `web-feature`)

**Interfaces:**
- Consumes: `Runtime` (`getRuntime().rpc.call`) and `RpcError` from `apps/web/src/runtime/index.ts`; `reportClientIssue` (Task 3); Task 13's model (`parseAccount`, `changedAccountFields`, `mergeAccount`); Task 14's applier (`applyAppearance`, `inlineAppearanceVars`, `writeBootCache`, `syncThemeColor`).
- Produces:
  - `type LoadResult = { kind: "loaded"; value: unknown; revision: number } | { kind: "unsupported" } | { kind: "failed"; code: string }`, `loadSetting(rpc: Runtime["rpc"], key: SettingKey): Promise<LoadResult>` (`unsupported` for `unknown_method`).
  - `type SaveStatus = "saving" | "saved" | "error"`, `type AccountStatus = "local" | "load-error" | SaveStatus`.
  - `interface AccountDocumentOptions<V> { key: SettingKey; write(value: V, baseRevision: number): SettingWrite; parse(value: unknown): V; changed(previous: V, next: V): readonly string[]; merge(server: V, local: V, dirty: ReadonlySet<string>): V; local(): V; adopt(value: V): void; onStatus(status: AccountStatus): void; delayMs?: number; timers?: Timers }`, `createAccountDocument<V>(options): { change(previous: V, next: V): void; sync(rpc: Runtime["rpc"]): Promise<void>; dispose(): void }`.
  - `useAppearanceStore` state: `{ account: AccountAppearance; device: DeviceAppearance; accountStatus: AccountStatus; deviceStored: boolean; setAccount(next): void; setDevice(next): void; replaceFromServer(account): void; setAccountStatus(status): void; resetAll(): { account; device } }` (`resetAll` returns the previous values for Undo and keeps the custom theme library; `deviceStored` is false when localStorage refused the last device write, and Settings says the values apply to this page only).
  - `startAppearance(win?: Window): { stop(): void }`, `syncAccountAppearance(rpc: Runtime["rpc"]): Promise<void>` (never rejects in practice: failures become `accountStatus`).
  - `features/appearance/index.ts` re-exports only `startAppearance` now (the one name `main.tsx` imports); Tasks 19b, 21 and 25 add `syncAccountAppearance`, `useAppearanceStore` and `AppearancePanel` when they first import them (M3-RT-13).

**Rulings (pre-dispatch):**
- Account settings are saved by compare-and-set with a field merge and one retry (owner R3-4): the document holds every change until its first load settles (`loaded`, or `unsupported`, or a server copy of `null`); after `load-error` it never saves until a later load succeeds (the status says so); one save at a time, each from the latest revision; on `conflict` it re-reads, lays the locally changed fields over the server copy and re-sends once; a second conflict, or any other failure, shows `error` and waits for the next change or sync (R105: never re-sent by itself); a re-sync cancels the debounce but keeps the changed fields and sends them after the reload. The server copy wins for every field this device did not change. [M3R60]
- Device settings (density, sizes, motion, chat width) and the language are never sent to the server (DESIGN §13, owner R3-3). [M3R61]
- "Reset to defaults" keeps the custom theme library (owner R3-2): it resets every other account field and every device field, and Undo restores both scopes. [M3R62]
- No live refresh between tabs in M3 (no `storage` listener, no settings stream): compare-and-set already prevents lost updates; another tab's change appears at its next connect or reload (R125's second stream, deferred). [M3R63]
- `accountStatus` means: `local` = nothing from the server applies (older daemon, or no document there yet); `load-error` = the server copy could not be read, this device's copy shows and nothing is saved; `saving` / `saved` / `error` = the last save's state. [M3R64]
- Reviewed by Opus (owner X2): persisted user data, lost updates, async ordering. [M3R65]

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/account-setting.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { RpcError, type RpcErrorCode } from "../runtime/index.ts";
import { createAccountDocument, loadSetting, type AccountStatus } from "./account-setting.ts";

type Doc = { readonly a: string; readonly b: string };
const EMPTY: Doc = { a: "", b: "" };

function manualTimers() {
  let next = 0;
  const due = new Map<number, () => void>();
  return {
    set: (fn: () => void) => (due.set(++next, fn), next),
    clear: (id: number) => void due.delete(id),
    fire: () => [...due.entries()].forEach(([id, fn]) => (due.delete(id), fn())),
    pending: () => due.size,
  };
}

// The fake server answers at once; this lets its promises and the document's follow-ups settle. Not a sleep.
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

type Step = () => unknown;
const loaded = (value: unknown, revision: number): Step => () => ({ value, revision });
const saved = (revision: number): Step => () => ({ revision });
const fails = (code: RpcErrorCode): Step => () => {
  throw new RpcError(code);
};

/** Answers settings.get and settings.set from scripted steps and records every call. */
function fakeServer(get: Step[], set: Step[]) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    const step = (method === "settings.get" ? get : set).shift();
    if (!step) throw new Error(`no scripted answer for ${method}`);
    return step();
  });
  return { rpc: { call } as never, calls, sets: () => calls.filter((c) => c.method === "settings.set").map((c) => c.params) };
}

function harness(initial: Doc = EMPTY) {
  let state = initial;
  const statuses: AccountStatus[] = [];
  const timers = manualTimers();
  const doc = createAccountDocument<Doc>({
    key: "appearance",
    write: (value, baseRevision) => ({ key: "appearance", value, baseRevision }) as never,
    parse: (value) => ({ ...EMPTY, ...(value as Partial<Doc>) }),
    changed: (previous, next) => (["a", "b"] as const).filter((name) => previous[name] !== next[name]),
    merge: (server, local, dirty) => ({ a: dirty.has("a") ? local.a : server.a, b: dirty.has("b") ? local.b : server.b }),
    local: () => state,
    adopt: (value) => {
      state = value;
    },
    onStatus: (status) => statuses.push(status),
    timers,
  });
  const edit = (next: Partial<Doc>) => {
    const previous = state;
    state = { ...state, ...next };
    doc.change(previous, state);
  };
  return { doc, edit, timers, statuses, state: () => state };
}

describe("loadSetting", () => {
  it("tells loaded, unsupported (older daemon) and failed apart", async () => {
    expect(await loadSetting({ call: vi.fn().mockResolvedValue({ value: { a: 1 }, revision: 2 }) } as never, "appearance")).toEqual({ kind: "loaded", value: { a: 1 }, revision: 2 });
    expect(await loadSetting({ call: vi.fn().mockRejectedValue(new RpcError("unknown_method")) } as never, "appearance")).toEqual({ kind: "unsupported" });
    expect(await loadSetting({ call: vi.fn().mockRejectedValue(new RpcError("connection_lost")) } as never, "appearance")).toEqual({ kind: "failed", code: "connection_lost" });
    expect(await loadSetting({ call: vi.fn().mockRejectedValue(new Error("boom")) } as never, "appearance")).toEqual({ kind: "failed", code: "internal" });
  });
});

describe("account document (compare-and-set, owner R3-4)", () => {
  it("holds a change made before the first load, then sends it on top of the server copy", async () => {
    const h = harness();
    h.edit({ a: "mine" });
    h.timers.fire();
    const server = fakeServer([loaded({ a: "theirs", b: "server" }, 3)], [saved(4)]);
    await h.doc.sync(server.rpc);
    await drain();
    expect(h.state()).toEqual({ a: "mine", b: "server" });
    expect(server.sets()).toEqual([{ key: "appearance", value: { a: "mine", b: "server" }, baseRevision: 3 }]);
    expect(h.statuses.at(-1)).toBe("saved");
  });

  it("never saves after a failed load; the next successful sync sends the change", async () => {
    const h = harness();
    const down = fakeServer([fails("connection_lost")], []);
    await h.doc.sync(down.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([down.sets(), h.statuses.at(-1)]).toEqual([[], "load-error"]);
    const up = fakeServer([loaded({ a: "", b: "server" }, 2)], [saved(3)]);
    await h.doc.sync(up.rpc);
    await drain();
    expect(up.sets()).toEqual([{ key: "appearance", value: { a: "mine", b: "server" }, baseRevision: 2 }]);
  });

  it("answers a conflict with a re-read, a merge and one retry", async () => {
    const h = harness();
    const server = fakeServer([loaded({ a: "", b: "" }, 1), loaded({ a: "", b: "other device" }, 2)], [fails("conflict"), saved(3)]);
    await h.doc.sync(server.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect(server.sets()).toEqual([
      { key: "appearance", value: { a: "mine", b: "" }, baseRevision: 1 },
      { key: "appearance", value: { a: "mine", b: "other device" }, baseRevision: 2 },
    ]);
    expect([h.state(), h.statuses.at(-1)]).toEqual([{ a: "mine", b: "other device" }, "saved"]);
  });

  it("reports a second conflict and waits for the next change", async () => {
    const h = harness();
    const server = fakeServer([loaded({}, 1), loaded({}, 2)], [fails("conflict"), fails("conflict")]);
    await h.doc.sync(server.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([server.sets().length, h.statuses.at(-1), h.timers.pending()]).toEqual([2, "error", 0]);
  });

  it("does not re-send a failed save by itself (R105); the next change sends it", async () => {
    const h = harness();
    const server = fakeServer([loaded({}, 1)], [fails("connection_lost"), saved(2)]);
    await h.doc.sync(server.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([server.sets().length, h.statuses.at(-1), h.timers.pending()]).toEqual([1, "error", 0]);
    h.edit({ b: "more" });
    h.timers.fire();
    await drain();
    expect(server.sets().at(-1)).toEqual({ key: "appearance", value: { a: "mine", b: "more" }, baseRevision: 1 });
  });

  it("sends one save at a time; a change made meanwhile goes out after it, from the new revision", async () => {
    const h = harness();
    let answer: (value: unknown) => void = () => {};
    const server = fakeServer([loaded({}, 1)], [() => new Promise((resolve) => (answer = resolve)), saved(3)]);
    await h.doc.sync(server.rpc);
    h.edit({ a: "one" });
    h.timers.fire();
    await drain();
    h.edit({ b: "two" });
    h.timers.fire();
    await drain();
    expect(server.sets()).toHaveLength(1);
    answer({ revision: 2 });
    await drain();
    expect(server.sets().at(-1)).toEqual({ key: "appearance", value: { a: "one", b: "two" }, baseRevision: 2 });
  });

  it("keeps a waiting change across a re-sync and sends it after the reload", async () => {
    const h = harness();
    const first = fakeServer([loaded({}, 1)], []);
    await h.doc.sync(first.rpc);
    h.edit({ a: "mine" });
    expect(h.timers.pending()).toBe(1);
    const second = fakeServer([loaded({ b: "server" }, 5)], [saved(6)]);
    await h.doc.sync(second.rpc);
    await drain();
    expect([first.sets(), second.sets()]).toEqual([[], [{ key: "appearance", value: { a: "mine", b: "server" }, baseRevision: 5 }]]);
    expect(h.timers.pending()).toBe(0);
  });

  it("drops the answer of an older sync", async () => {
    const h = harness();
    let late: (value: unknown) => void = () => {};
    const slow = fakeServer([() => new Promise((resolve) => (late = resolve))], []);
    const pending = h.doc.sync(slow.rpc);
    await h.doc.sync(fakeServer([loaded({ b: "new" }, 7)], []).rpc);
    late({ value: { b: "old" }, revision: 6 });
    await pending;
    expect(h.state()).toEqual({ a: "", b: "new" });
  });

  it("sends nothing to an older daemon, and nothing without a change", async () => {
    const h = harness();
    const old = fakeServer([fails("unknown_method")], []);
    await h.doc.sync(old.rpc);
    h.edit({ a: "mine" });
    h.timers.fire();
    await drain();
    expect([old.sets(), h.statuses.at(-1)]).toEqual([[], "local"]);
    const quiet = harness();
    const empty = fakeServer([loaded(null, 0)], []);
    await quiet.doc.sync(empty.rpc);
    expect([empty.sets(), quiet.statuses.at(-1)]).toEqual([[], "local"]);
  });
});
```

`apps/web/src/features/appearance/controller.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { startAppearance, syncAccountAppearance } from "./controller.ts";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE } from "./model.ts";

const ocean = { id: "ocean", name: "Ocean", base: "night", roles: { bg: "#0e1626", surface: "#132033", text: "#e6edf7", agent: "#38bdf8", you: "#fb923c", attn: "#ec4899", ok: "#34d399", err: "#f87171" } } as const;

let listeners: Array<() => void> = [];
let light = false;
let controller: { stop(): void } | null = null;
const root = document.documentElement;
// Lets the scripted server's promises and the document's follow-ups settle (microtasks only, not a sleep).
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

/** settings.get and settings.set answers per call; anything else is a test bug. */
function server(get: Array<() => unknown>, set: Array<() => unknown> = []) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    const step = (method === "settings.get" ? get : set).shift();
    if (!step) throw new Error(`no scripted answer for ${method}`);
    return step();
  });
  return { rpc: { call } as never, sets: () => calls.filter((c) => c.method === "settings.set").map((c) => c.params) };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  root.removeAttribute("style");
  useAppearanceStore.setState({ account: DEFAULT_ACCOUNT, device: DEFAULT_DEVICE, accountStatus: "local", deviceStored: true });
  listeners = [];
  light = false;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return light && query.includes("light");
    },
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => (listeners = listeners.filter((l) => l !== fn)),
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  controller?.stop();
  controller = null;
  vi.useRealTimers();
  localStorage.clear();
});

describe("appearance controller", () => {
  it("applies the device settings at start and follows the system theme", () => {
    useAppearanceStore.getState().setDevice({ ...DEFAULT_DEVICE, density: "mixed" });
    controller = startAppearance(window);
    expect([root.dataset.density, root.dataset.theme]).toEqual(["mixed", "night"]);
    light = true;
    listeners.forEach((fn) => fn());
    expect(root.dataset.theme).toBe("day");
    controller.stop();
    controller = null;
    expect(listeners).toHaveLength(0);
  });

  it("re-applies when the store changes and caches the account for the boot script", () => {
    controller = startAppearance(window);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, mode: "day", grid: false });
    expect([root.dataset.theme, root.dataset.grid]).toEqual(["day", "off"]);
    expect(JSON.parse(localStorage.getItem("pap.appearance.boot") ?? "{}").mode).toBe("day");
  });

  it("removes the boot-set variables the app does not resolve on the first apply (M3-RT-11)", () => {
    root.style.setProperty("--bg", "#000000");
    root.style.setProperty("--app-viewport-height", "400px");
    controller = startAppearance(window);
    expect([root.style.getPropertyValue("--bg"), root.style.getPropertyValue("--app-viewport-height")]).toEqual(["", "400px"]);
  });

  it("takes the server's account once connected", async () => {
    controller = startAppearance(window);
    await syncAccountAppearance(server([() => ({ value: { ...DEFAULT_ACCOUNT, railPosition: "right" }, revision: 3 })]).rpc);
    expect([root.dataset.rail, useAppearanceStore.getState().accountStatus]).toEqual(["right", "saved"]);
  });

  it("sends a change made before the sync after the load, merged over the server copy", async () => {
    controller = startAppearance(window);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    await vi.advanceTimersByTimeAsync(400);
    const s = server([() => ({ value: { ...DEFAULT_ACCOUNT, railPosition: "right" }, revision: 3 })], [() => ({ revision: 4 })]);
    await syncAccountAppearance(s.rpc);
    await drain();
    expect(useAppearanceStore.getState().account).toEqual({ ...DEFAULT_ACCOUNT, railPosition: "right", grid: false });
    expect(s.sets()).toEqual([{ key: "appearance", value: { ...DEFAULT_ACCOUNT, railPosition: "right", grid: false }, baseRevision: 3 }]);
  });

  it("never overwrites a change made while the server answer was on its way", async () => {
    controller = startAppearance(window);
    let answer: (v: unknown) => void = () => {};
    const s = server([() => new Promise((resolve) => (answer = resolve))], [() => ({ revision: 5 })]);
    const pending = syncAccountAppearance(s.rpc);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    answer({ value: { ...DEFAULT_ACCOUNT, grid: true, railPosition: "right" }, revision: 4 });
    await pending;
    await drain();
    expect(useAppearanceStore.getState().account).toEqual({ ...DEFAULT_ACCOUNT, grid: false, railPosition: "right" });
    expect(s.sets()).toHaveLength(1);
  });

  it("after a load failure, shows it and saves nothing", async () => {
    controller = startAppearance(window);
    const s = server([() => Promise.reject(new Error("boom"))]);
    await syncAccountAppearance(s.rpc);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect([useAppearanceStore.getState().accountStatus, s.sets()]).toEqual(["load-error", []]);
  });

  it("keeps the local values for an older daemon and never saves to it", async () => {
    controller = startAppearance(window);
    const s = server([() => Promise.reject(new RpcError("unknown_method"))]);
    await syncAccountAppearance(s.rpc);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect([useAppearanceStore.getState().accountStatus, s.sets(), root.dataset.grid]).toEqual(["local", [], "off"]);
  });

  it("marks device settings as page-only when storage refuses them", () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("denied");
    };
    useAppearanceStore.getState().setDevice({ ...DEFAULT_DEVICE, motion: "none" });
    Storage.prototype.setItem = setItem;
    expect(useAppearanceStore.getState().deviceStored).toBe(false);
    expect(useAppearanceStore.getState().device.motion).toBe("none");
  });

  it("reset keeps the custom themes and returns both previous scopes for Undo (owner R3-2)", () => {
    const account = { ...DEFAULT_ACCOUNT, customThemes: [ocean], darkTheme: "ocean", grid: false };
    useAppearanceStore.setState({ account, device: { ...DEFAULT_DEVICE, density: "comfortable" } });
    const previous = useAppearanceStore.getState().resetAll();
    expect(useAppearanceStore.getState().account).toEqual({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
    expect(useAppearanceStore.getState().device).toEqual(DEFAULT_DEVICE);
    expect(previous).toEqual({ account, device: { ...DEFAULT_DEVICE, density: "comfortable" } });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/lib apps/web/src/features/appearance`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/lib/account-setting.ts`:

```ts
import type { SettingKey, SettingWrite } from "@pap/contracts";
import { RpcError, type Runtime } from "../runtime/index.ts";
import { reportClientIssue } from "./report.ts";

export type SaveStatus = "saving" | "saved" | "error";
export type AccountStatus = "local" | "load-error" | SaveStatus;
export type LoadResult =
  | { readonly kind: "loaded"; readonly value: unknown; readonly revision: number }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly code: string };
type Rpc = Runtime["rpc"];
type Timers = { set(fn: () => void, ms: number): number; clear(id: number): void };
const WINDOW_TIMERS: Timers = { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) };

/** No deadline of its own: the runtime settles every call when the socket is declared dead (spec C §4.2). */
export async function loadSetting(rpc: Rpc, key: SettingKey): Promise<LoadResult> {
  try {
    const { value, revision } = await rpc.call("settings.get", { key });
    return { kind: "loaded", value, revision };
  } catch (error) {
    const code = error instanceof RpcError ? error.code : "internal";
    return code === "unknown_method" ? { kind: "unsupported" } : { kind: "failed", code };
  }
}

export interface AccountDocumentOptions<V> {
  readonly key: SettingKey;
  write(value: V, baseRevision: number): SettingWrite;
  /** Field by field; never throws. */
  parse(value: unknown): V;
  /** The names of the fields that differ (a list document is one field). */
  changed(previous: V, next: V): readonly string[];
  /** The server copy with the local values of `dirty` laid over it. */
  merge(server: V, local: V, dirty: ReadonlySet<string>): V;
  /** The value the person sees now. */
  local(): V;
  /** Puts a (merged) server copy in place; it must not come back through `change`. */
  adopt(value: V): void;
  onStatus(status: AccountStatus): void;
  readonly delayMs?: number;
  readonly timers?: Timers;
}

export interface AccountDocument<V> {
  /** A local change, already applied by the caller: saved `delayMs` later, once the document has been loaded. */
  change(previous: V, next: V): void;
  /** Each time the socket opens: read the server copy, merge the local changes over it, send them. */
  sync(rpc: Rpc): Promise<void>;
  dispose(): void;
}

type Phase = "unloaded" | "loading" | "loaded" | "load-failed" | "unsupported";

/**
 * One account document kept in step with the server by compare-and-set (owner R3-4, M3-RT-01). Nothing is sent
 * before the first load settles or after a failed one; one save at a time, from the latest revision; a conflict
 * re-reads, merges the fields changed here and retries once; any other failed save waits for the next change or
 * sync (R105); a re-sync keeps a waiting change and sends it after the reload.
 */
export function createAccountDocument<V>(options: AccountDocumentOptions<V>): AccountDocument<V> {
  const timers = options.timers ?? WINDOW_TIMERS;
  const delayMs = options.delayMs ?? 400;
  let rpc: Rpc | null = null;
  let phase: Phase = "unloaded";
  let revision = 0;
  // Bounded by the document's field names.
  let dirty = new Set<string>();
  let timer: number | null = null;
  let inFlight: Promise<void> | null = null;
  let held = false;
  let loads = 0;
  let disposed = false;

  const status = (next: AccountStatus): void => {
    if (!disposed) options.onStatus(next);
  };
  const stopTimer = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  /** True when the document is loaded and may save. */
  async function load(call: Rpc): Promise<boolean> {
    const mine = ++loads;
    phase = "loading";
    const result = await loadSetting(call, options.key);
    if (disposed || mine !== loads) return false; // a newer sync owns the document now
    if (result.kind === "unsupported") {
      phase = "unsupported"; // an older daemon: the local values stay, nothing is ever sent
      status("local");
      return false;
    }
    if (result.kind === "failed") {
      phase = "load-failed";
      reportClientIssue("setting_load_failed");
      status("load-error");
      return false;
    }
    revision = result.revision;
    if (result.value !== null) options.adopt(options.merge(options.parse(result.value), options.local(), dirty));
    phase = "loaded";
    held = false;
    if (dirty.size === 0) status(result.value === null ? "local" : "saved");
    return true;
  }

  async function save(call: Rpc, retried: boolean): Promise<void> {
    const batch = dirty;
    dirty = new Set();
    status("saving");
    try {
      revision = (await call.call("settings.set", options.write(options.local(), revision))).revision;
      if (dirty.size === 0) status("saved");
    } catch (error) {
      for (const field of batch) dirty.add(field);
      if (disposed) return;
      if (error instanceof RpcError && error.code === "conflict" && !retried) {
        if (await load(call)) await save(call, true);
        return; // a failed reload has reported itself; nothing is sent until a later load succeeds
      }
      held = true; // R105: a failed save is never re-sent by itself
      reportClientIssue("setting_save_failed");
      status("error");
    }
  }

  function pump(): void {
    if (disposed || inFlight !== null || held || phase !== "loaded" || rpc === null || dirty.size === 0) return;
    inFlight = save(rpc, false)
      .catch(() => {
        // save() settles every failure itself; this only guards a throwing option (a bug), never silently.
        reportClientIssue("setting_save_failed");
        status("error");
      })
      .finally(() => {
        inFlight = null;
        pump(); // a change made while the save travelled goes out now, from the new revision
      });
  }

  return {
    change(previous, next) {
      for (const field of options.changed(previous, next)) dirty.add(field);
      if (dirty.size === 0) return;
      held = false;
      if (phase !== "loaded") return; // held until the first load settles, and after a failed one
      stopTimer();
      timer = timers.set(() => {
        timer = null;
        pump();
      }, delayMs);
    },
    async sync(call) {
      rpc = call;
      stopTimer(); // a waiting change stays in `dirty` and goes out after the reload
      if (inFlight) await inFlight;
      if (await load(call)) pump();
    },
    dispose() {
      disposed = true;
      stopTimer();
    },
  };
}
```

(`rpc.call("settings.set", …)` is a mutation: the runtime gives it a fresh `commandId` per call, so the conflict retry is a new command, never a replay of the refused one.)

`apps/web/src/features/appearance/appearance-store.ts`: as described in Interfaces. Reading: `localStorage.getItem` inside `try`, a throw reads as "nothing stored" (defaults; the boot path already reported it). Writing: `setDevice` sets `deviceStored` to the result of the write; `setAccount` and `replaceFromServer` write the local account cache (`ACCOUNT_CACHE_KEY`) and call `reportClientIssue("storage_refused")` when it fails (the server copy still saves). The account cache is read through `parseAccount`, field by field.

```ts
import type { AccountAppearance } from "@pap/contracts";
import { create } from "zustand";
import type { AccountStatus } from "../../lib/account-setting.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { ACCOUNT_CACHE_KEY, DEFAULT_ACCOUNT, DEFAULT_DEVICE, DEVICE_KEY, parseAccount, parseDevice, type DeviceAppearance } from "./model.ts";

interface AppearanceState {
  readonly account: AccountAppearance;
  readonly device: DeviceAppearance;
  readonly accountStatus: AccountStatus;
  readonly deviceStored: boolean;
  setAccount(next: AccountAppearance): void;
  setDevice(next: DeviceAppearance): void;
  /** A server copy (already merged): cached locally; its status is the account document's to report. */
  replaceFromServer(account: AccountAppearance): void;
  setAccountStatus(status: AccountStatus): void;
  /** Defaults for both scopes, keeping the custom theme library (owner R3-2); returns the previous values for Undo. */
  resetAll(): { account: AccountAppearance; device: DeviceAppearance };
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // a locked-down browser: defaults, already reported by the boot path
  }
};
const write = (key: string, value: unknown): boolean => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    reportClientIssue("storage_refused");
    return false;
  }
};
const cachedAccount = (): AccountAppearance => {
  const raw = read(ACCOUNT_CACHE_KEY);
  try {
    return parseAccount(raw === null ? null : JSON.parse(raw));
  } catch {
    return DEFAULT_ACCOUNT; // unreadable JSON: the server copy replaces it at the next sync
  }
};

export const useAppearanceStore = create<AppearanceState>()((set, get) => ({
  account: cachedAccount(),
  device: parseDevice(read(DEVICE_KEY)),
  accountStatus: "local",
  deviceStored: true,
  setAccount: (account) => {
    write(ACCOUNT_CACHE_KEY, account);
    set({ account });
  },
  setDevice: (device) => set({ device, deviceStored: write(DEVICE_KEY, device) }),
  replaceFromServer: (account) => {
    write(ACCOUNT_CACHE_KEY, account);
    set({ account });
  },
  setAccountStatus: (accountStatus) => set({ accountStatus }),
  resetAll: () => {
    const previous = { account: get().account, device: get().device };
    get().setAccount({ ...DEFAULT_ACCOUNT, customThemes: previous.account.customThemes });
    get().setDevice(DEFAULT_DEVICE);
    return previous;
  },
}));
```

`apps/web/src/features/appearance/controller.ts`:

```ts
import type { AccountAppearance } from "@pap/contracts";
import { createAccountDocument, type AccountDocument } from "../../lib/account-setting.ts";
import type { Runtime } from "../../runtime/index.ts";
import { applyAppearance, inlineAppearanceVars, syncThemeColor, writeBootCache } from "./apply.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { changedAccountFields, mergeAccount, parseAccount, resolveAppearance, toBootCache } from "./model.ts";

const LIGHT = "(prefers-color-scheme: light)";
let active: { stop(): void } | null = null;
let accountDocument: AccountDocument<AccountAppearance> | null = null;

/** Applies the appearance now and on every change of the store or of the system theme. Once, before the first render. */
export function startAppearance(win: Window = window): { stop(): void } {
  active?.stop();
  const root = win.document.documentElement;
  // Start from what the boot script set, so the first apply removes what the app no longer resolves (M3-RT-11).
  let vars = inlineAppearanceVars(root);
  const media = typeof win.matchMedia === "function" ? win.matchMedia(LIGHT) : null;
  const apply = () => {
    const { account, device } = useAppearanceStore.getState();
    vars = applyAppearance(root, resolveAppearance(account, device, media?.matches ?? false), vars);
    writeBootCache(win.localStorage, toBootCache(account, device));
    syncThemeColor(root, win.document);
  };
  let adopting = false;
  const doc = createAccountDocument<AccountAppearance>({
    key: "appearance",
    write: (value, baseRevision) => ({ key: "appearance", value, baseRevision }),
    parse: parseAccount,
    changed: changedAccountFields,
    merge: mergeAccount,
    local: () => useAppearanceStore.getState().account,
    adopt: (account) => {
      adopting = true;
      try {
        useAppearanceStore.getState().replaceFromServer(account);
      } finally {
        adopting = false;
      }
    },
    onStatus: (status) => useAppearanceStore.getState().setAccountStatus(status),
  });
  accountDocument = doc;
  apply();
  media?.addEventListener("change", apply);
  const unsubscribe = useAppearanceStore.subscribe((state, previous) => {
    if (state.account === previous.account && state.device === previous.device) return;
    apply();
    if (state.account !== previous.account && !adopting) doc.change(previous.account, state.account);
  });
  active = {
    stop() {
      media?.removeEventListener("change", apply);
      unsubscribe();
      doc.dispose();
      if (accountDocument === doc) accountDocument = null;
      active = null;
    },
  };
  return active;
}

/** Each time the socket opens (Task 19b): read the server copy, merge this device's changes, send them. */
export function syncAccountAppearance(rpc: Runtime["rpc"]): Promise<void> {
  return accountDocument?.sync(rpc) ?? Promise.resolve();
}

// A hot update replaces this module: the old controller must not keep its listeners (R125).
if (import.meta.hot) import.meta.hot.dispose(() => active?.stop());
```

`apps/web/src/features/appearance/index.ts`: `export { startAppearance } from "./controller.ts";` (later tasks add their names, M3-RT-13).

`apps/web/src/main.tsx`: after the locale lines and before `createRoot`, call `startAppearance();` (from `./features/appearance/index.ts`). In `eslint.config.js`, add `"web-feature"` to the allow list of `web-root` (`web-lib` was added in Task 3).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck && pnpm knip`
Expected: PASS. Mutation checks (each must turn a named test red): let `change()` schedule a save before the first load → "holds a change made before the first load"; save after `load-error` → "never saves after a failed load"; skip the `!retried` guard → "reports a second conflict and waits" loops or fails; let `pump()` run while `held` → "does not re-send a failed save by itself"; let `pump()` start a second save while one is in flight → "sends one save at a time"; drop the `mine !== loads` check → "drops the answer of an older sync"; dispose the document in `sync()` instead of keeping `dirty` → "keeps a waiting change across a re-sync"; reset `customThemes` in `resetAll` → "reset keeps the custom themes".

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web eslint.config.js
git commit -m "feat(appearance): store, controller and compare-and-set account sync"
```

---
# Phase 5 — Commands: keybindings, dispatcher, palette core

### Task 16a: Keybinding core, part 1 — chords, physical keys, labels

Pure functions, no DOM. The format is T3's (`packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`): a JSON array of `{ key, command, when? }`, later rules win, user rules replace the defaults of the commands they name (T3 `mergeWithDefaultKeybindings`, shared 451-469), the `when` grammar is identifiers with `!`, `&&`, `||` and parentheses (shared 282-414, depth ≤ 64, unknown identifiers are false). Matching is layout-aware the way Orca does it (`src/shared/keybindings/matching-key.ts`, `input.ts`): the layout key first, the physical key for digits and punctuation, and for letters only when the layout key is unusable (dead key, a non-Latin letter under Ctrl/Cmd, a macOS Option composition). AltGr never matches (pw: `hooks/useKeyboardShortcuts.ts`, T3 shared 100-113); composition keys never match (T3 + Orca bail-outs). Labels follow pw `lib/shortcut-label.ts`: `⌃⌥⇧⌘` glyphs joined without a separator on Apple platforms, `Ctrl+Alt+N` elsewhere. Browser-reserved chords are flagged (Orca's `ignoredActionIds` idea for OS-reserved chords; Review Focus 4).

This part holds the chord model and the labels; Task 16b adds `when` clauses, the defaults, the merge and the conflict checks.

**Files:**
- Create: `apps/web/src/features/commands/keys.ts`, `keys.test.ts`, `labels.ts`, `labels.test.ts`
- Modify: `apps/web/src/i18n/catalog/commands.ts` (key names), `apps/web/src/i18n/i18n.test.ts` (`IDENTICAL_IN_FR` for the key names that are the same word)

**Interfaces:**
- Consumes: `KEY_NONE` (Task 12); `cancelsComposition` (Task 6); `Translate` (Task 3).
- Produces:
  - `type Platform = "mac" | "other"`; `interface Chord { mod; ctrl; meta; alt; shift: boolean; key: string }`; `parseChord(text: string): Chord | null`; `interface KeyInput { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number; getModifierState?(name: string): boolean }`; `keyCandidates(event: KeyInput, platform): string[]`; `matchesChord(chord, event, platform): boolean`; `chordId(chord, platform): string` (canonical `ctrl+alt+shift+meta+<key>`); `chordFromEvent(event, platform): string | null` (for the recorder; `mod` on the platform's own modifier; digits and punctuation by physical key).
  - `type KeyNames = Readonly<Record<"ctrl" | "alt" | "shift" | "meta" | "escape" | "enter" | "space" | "tab" | "backspace" | "delete" | "up" | "down" | "left" | "right" | "home" | "end" | "pageup" | "pagedown", string>>`; `keyNames(t: Translate): KeyNames` (consumed by Tasks 17b, 22 and 27, M3-RT-41); `detectPlatform(nav?: { platform?: string; userAgent?: string }): Platform`; `chordTokens(chord, platform, names: KeyNames): string[]`; `chordJoiner(platform): "" | "+"`; `ariaKeyShortcuts(chord, platform): string`.

**Rulings (pre-dispatch):**
- A shifted symbol (`?`) matches whatever Shift the layout needs, but only through the layout key; a match through the physical key needs the exact Shift, so a binding of `/` never fires on Shift+/ (M3-RT-28). [M3R66]
- On Windows, `Ctrl+Alt` is AltGr, so `Ctrl+Alt+1..9` and `Ctrl+Alt+N` do not fire there (pi-web's accepted trade-off). [M3R67]
- The recorder stores digits and punctuation by physical key (owner R3-7): AZERTY Ctrl+1 is `mod+1`, not `mod+&`; letters keep the layout key (AZERTY "?" on the `KeyM` position stays `shift+?`). [M3R68]

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/commands/keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chordFromEvent, chordId, keyCandidates, matchesChord, parseChord, type KeyInput } from "./keys.ts";

const ev = (over: Partial<KeyInput>): KeyInput => ({ key: "k", code: "KeyK", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

describe("parseChord", () => {
  it("reads modifiers, aliases and the plus key", () => {
    expect(parseChord("Mod+K")).toEqual({ mod: true, ctrl: false, meta: false, alt: false, shift: false, key: "k" });
    expect(parseChord("ctrl+alt+esc")?.key).toBe("escape");
    expect(parseChord("mod++")?.key).toBe("+");
    expect(parseChord("alt+shift+right")?.key).toBe("arrowright");
  });
  it("refuses empty, none, two keys, doubled or ambiguous modifiers, unknown names", () => {
    for (const bad of ["", "none", "a+b", "ctrl+ctrl+k", "mod+ctrl+k", "mod+meta+k", "ctrl+", "mod+banana"]) expect(parseChord(bad), bad).toBeNull();
  });
});

describe("matching", () => {
  it("resolves mod to Cmd on Apple platforms and Ctrl elsewhere, with exact modifiers", () => {
    const chord = parseChord("mod+k");
    if (!chord) throw new Error("chord");
    expect(matchesChord(chord, ev({ metaKey: true }), "mac")).toBe(true);
    expect(matchesChord(chord, ev({ ctrlKey: true }), "mac")).toBe(false);
    expect(matchesChord(chord, ev({ ctrlKey: true }), "other")).toBe(true);
    expect(matchesChord(chord, ev({ ctrlKey: true, shiftKey: true }), "other")).toBe(false);
  });

  it("never matches during a composition, Safari's keyCode 229, Process, or AltGr", () => {
    expect(keyCandidates(ev({ isComposing: true }), "other")).toEqual([]);
    expect(keyCandidates(ev({ keyCode: 229 }), "mac")).toEqual([]);
    expect(keyCandidates(ev({ key: "Process" }), "other")).toEqual([]);
    expect(keyCandidates(ev({ key: "@", code: "Digit0", ctrlKey: true, altKey: true, getModifierState: (n) => n === "AltGraph" }), "other")).toEqual([]);
  });

  it("finds Ctrl+K on a Cyrillic layout and Option+W on a Mac through the physical key", () => {
    expect(matchesChord(parseChord("mod+k") as never, ev({ key: "л", ctrlKey: true }), "other")).toBe(true);
    expect(matchesChord(parseChord("alt+w") as never, ev({ key: "∑", code: "KeyW", altKey: true }), "mac")).toBe(true);
  });

  it("matches digits by their physical key (AZERTY Ctrl+Alt+1 on Linux types &)", () => {
    expect(matchesChord(parseChord("ctrl+alt+1") as never, ev({ key: "&", code: "Digit1", ctrlKey: true, altKey: true }), "other")).toBe(true);
  });

  it("does not take a letter's physical key when the layout key is a usable letter (AZERTY A is not Q)", () => {
    expect(matchesChord(parseChord("mod+q") as never, ev({ key: "a", code: "KeyQ", ctrlKey: true }), "other")).toBe(false);
    expect(matchesChord(parseChord("mod+a") as never, ev({ key: "a", code: "KeyQ", ctrlKey: true }), "other")).toBe(true);
  });

  it("lets a shifted symbol match whatever Shift the layout needs, through the layout key only", () => {
    expect(matchesChord(parseChord("?") as never, ev({ key: "?", code: "Slash", shiftKey: true }), "other")).toBe(true);
    expect(matchesChord(parseChord("?") as never, ev({ key: "?", code: "KeyM", shiftKey: true }), "other")).toBe(true);
    // A physical "/" must not fire on Shift+/ ("?"): a match through the physical key needs the exact Shift (M3-RT-28).
    expect(matchesChord(parseChord("/") as never, ev({ key: "?", code: "Slash", shiftKey: true }), "other")).toBe(false);
    expect(matchesChord(parseChord("shift+/") as never, ev({ key: "?", code: "Slash", shiftKey: true }), "other")).toBe(true);
  });

  it("gives one identity per platform and records chords with mod", () => {
    expect(chordId(parseChord("mod+shift+k") as never, "mac")).toBe("shift+meta+k");
    expect(chordId(parseChord("ctrl+shift+k") as never, "other")).toBe(chordId(parseChord("mod+shift+k") as never, "other"));
    expect(chordFromEvent(ev({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }), "other")).toBe("mod+shift+p");
    expect(chordFromEvent(ev({ key: "Control", code: "ControlLeft", ctrlKey: true }), "other")).toBeNull();
  });

  it("records digits and punctuation by physical key, letters by layout key (owner R3-7)", () => {
    // AZERTY Ctrl+1 types "&": the binding is stored as mod+1, so it means the same key on a QWERTY device.
    expect(chordFromEvent(ev({ key: "&", code: "Digit1", ctrlKey: true }), "other")).toBe("mod+1");
    expect(chordFromEvent(ev({ key: "?", code: "Slash", shiftKey: true }), "other")).toBe("shift+/");
    // AZERTY's "?" sits on the KeyM position: a letter code, so the layout character is kept.
    expect(chordFromEvent(ev({ key: "?", code: "KeyM", shiftKey: true }), "other")).toBe("shift+?");
    expect(chordFromEvent(ev({ key: "a", code: "KeyQ", ctrlKey: true }), "other")).toBe("mod+a");
  });
});
```

`apps/web/src/features/commands/labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { ariaKeyShortcuts, chordJoiner, chordTokens, detectPlatform, keyNames, type KeyNames } from "./labels.ts";

const names: KeyNames = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta", escape: "Esc", enter: "Enter", space: "Space", tab: "Tab", backspace: "Backspace", delete: "Del", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn" };

describe("labels (pw lib/shortcut-label.ts)", () => {
  it("detects Apple platforms, iPad included", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ platform: "iPhone" })).toBe("mac");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/16.4 Safari" })).toBe("mac");
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("other");
  });
  it("uses ⌃⌥⇧⌘ glyphs in that order on Apple platforms and names elsewhere", () => {
    const chord = parseChord("mod+alt+shift+n") as never;
    expect(chordTokens(chord, "mac", names)).toEqual(["⌥", "⇧", "⌘", "N"]);
    expect(chordTokens(chord, "other", names)).toEqual(["Ctrl", "Alt", "Shift", "N"]);
    expect([chordJoiner("mac"), chordJoiner("other")]).toEqual(["", "+"]);
    expect(chordTokens(parseChord("alt+shift+right") as never, "mac", names)).toEqual(["⌥", "⇧", "→"]);
  });
  it("builds the key names from the catalog of the current language", () => {
    const names = keyNames((key) => `<${key}>`);
    expect([names.ctrl, names.escape, names.pagedown]).toEqual(["<commands.key.ctrl>", "<commands.key.escape>", "<commands.key.pagedown>"]);
  });

  it("writes aria-keyshortcuts in the ARIA form", () => {
    expect(ariaKeyShortcuts(parseChord("mod+k") as never, "mac")).toBe("Meta+K");
    expect(ariaKeyShortcuts(parseChord("mod+k") as never, "other")).toBe("Control+K");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/commands`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/web/src/features/commands/keys.ts`:

```ts
import { KEY_NONE } from "@pap/contracts";
import { cancelsComposition } from "@pap/ui";

export type Platform = "mac" | "other";

export interface Chord {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: string;
}

export interface KeyInput {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  getModifierState?(name: string): boolean;
}

type ModifierName = "mod" | "ctrl" | "meta" | "alt" | "shift";
const MODIFIERS: Readonly<Record<string, ModifierName>> = { mod: "mod", cmd: "meta", meta: "meta", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift" };
const ALIASES: Readonly<Record<string, string>> = { esc: "escape", space: " ", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", del: "delete", return: "enter" };
const NAMED = new Set(["escape", "enter", "tab", "backspace", "delete", " ", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "pageup", "pagedown", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);
const CODE_KEYS: Readonly<Record<string, string>> = { Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Space: " " };
const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "os", "altgraph", "capslock"]);

const isPrintable = (key: string) => [...key].length === 1 && key !== " ";

export function parseChord(text: string): Chord | null {
  const raw = text.trim().toLowerCase();
  if (raw === "" || raw === KEY_NONE) return null;
  // A trailing "++" is the plus key (T3: "mod++").
  const parts = raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const chord = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (modifier) {
      if (chord[modifier]) return null;
      chord[modifier] = true;
      continue;
    }
    if (chord.key !== "" || part === "") return null;
    const key = ALIASES[part] ?? part;
    if (!NAMED.has(key) && !isPrintable(key)) return null;
    chord.key = key;
  }
  // Orca: either Mod or a platform modifier, not both (Mod+Ctrl is Ctrl+Ctrl off Apple platforms).
  if (chord.key === "" || (chord.mod && (chord.ctrl || chord.meta))) return null;
  return chord;
}

function codeKey(code: string): string | null {
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  return CODE_KEYS[code] ?? null;
}

interface Candidates {
  /** The layout's key, when it is usable for a shortcut. */
  readonly layout: string | null;
  /** The physical key: always for digits and punctuation, for a letter only when the layout key is unusable. */
  readonly physical: string | null;
}

/** Null during a composition, for an input method's Process key, and for AltGr. */
function candidatesOf(event: KeyInput, platform: Platform): Candidates | null {
  if (cancelsComposition(event) || event.key === "Process") return null;
  if (platform === "other" && event.getModifierState?.("AltGraph") === true) return null;
  const layout = event.key === " " ? " " : event.key.toLowerCase();
  const physical = codeKey(event.code);
  const unusable = layout === "" || layout === "dead" || layout === "unidentified";
  const nonLatinUnderCommand = /^\p{L}$/u.test(layout) && !/^[a-z]$/.test(layout) && (event.ctrlKey || event.metaKey);
  const macComposed = platform === "mac" && event.altKey && isPrintable(layout) && !/^[\x20-\x7e]$/.test(layout);
  const layoutUsable = !unusable && !nonLatinUnderCommand && !macComposed;
  return {
    layout: layoutUsable ? layout : null,
    physical: physical !== null && (!/^[a-z]$/.test(physical) || !layoutUsable) ? physical : null,
  };
}

/** The keys an event can stand for (layout key first). Empty during a composition, for Process, and for AltGr. */
export function keyCandidates(event: KeyInput, platform: Platform): string[] {
  const candidates = candidatesOf(event, platform);
  if (candidates === null) return [];
  return [...new Set([candidates.layout, candidates.physical].filter((key): key is string => key !== null))];
}

const SHIFTED_SYMBOL = /^[^a-z0-9\s]$/u;

export function matchesChord(chord: Chord, event: KeyInput, platform: Platform): boolean {
  const candidates = candidatesOf(event, platform);
  if (candidates === null) return false;
  const byLayout = candidates.layout === chord.key;
  if (!byLayout && candidates.physical !== chord.key) return false;
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.altKey !== chord.alt) return false;
  // The Shift of a symbol such as "?" belongs to the layout, not to the chord; a match through the physical key
  // needs the exact Shift, so a physical "/" never fires on Shift+/ (M3-RT-28).
  const symbol = byLayout && !chord.shift && SHIFTED_SYMBOL.test(chord.key);
  return symbol || event.shiftKey === chord.shift;
}

/** Canonical identity on one platform: conflicts and reserved chords compare these. */
export function chordId(chord: Chord, platform: Platform): string {
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  return [ctrl && "ctrl", chord.alt && "alt", chord.shift && "shift", meta && "meta", chord.key].filter(Boolean).join("+");
}

/**
 * For the shortcut recorder: the chord an event stands for, written with `mod`; null for a lone modifier. Digits and
 * punctuation are recorded by physical key (owner R3-7): an account binding is shared by devices with other layouts,
 * and AZERTY's Ctrl+1 must not be stored as "mod+&". Letters keep the layout key.
 */
export function chordFromEvent(event: KeyInput, platform: Platform): string | null {
  const candidates = candidatesOf(event, platform);
  if (candidates === null || MODIFIER_KEYS.has(event.key.toLowerCase())) return null;
  const key = candidates.physical !== null && !/^[a-z]$/.test(candidates.physical) ? candidates.physical : (candidates.layout ?? candidates.physical);
  if (key === null) return null;
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  const parts = [mod && "mod", (platform === "mac" ? event.ctrlKey : event.metaKey) && (platform === "mac" ? "ctrl" : "meta"), event.altKey && "alt", event.shiftKey && "shift", key === " " ? "space" : key];
  return parts.filter(Boolean).join("+");
}
```

`labels.ts`:

```ts
import type { MessageKey, Translate } from "../../i18n/index.ts";
import type { Chord, Platform } from "./keys.ts";

export type KeyNames = Readonly<Record<"ctrl" | "alt" | "shift" | "meta" | "escape" | "enter" | "space" | "tab" | "backspace" | "delete" | "up" | "down" | "left" | "right" | "home" | "end" | "pageup" | "pagedown", string>>;

const MAC_GLYPHS: Readonly<Record<string, string>> = { escape: "⎋", enter: "↩", tab: "⇥", backspace: "⌫", delete: "⌦", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" };
const NAMED: Readonly<Record<string, keyof KeyNames>> = { escape: "escape", enter: "enter", " ": "space", tab: "tab", backspace: "backspace", delete: "delete", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", home: "home", end: "end", pageup: "pageup", pagedown: "pagedown" };

/** Orca: never hard-code metaKey; Apple platforms (iPadOS reports "Macintosh") use ⌘. */
export function detectPlatform(nav: { platform?: string; userAgent?: string } = navigator): Platform {
  return /Mac|iPhone|iPad|iPod/.test(nav.platform ?? "") || /Macintosh|iPhone|iPad/.test(nav.userAgent ?? "") ? "mac" : "other";
}

function keyLabel(key: string, platform: Platform, names: KeyNames): string {
  if (platform === "mac" && MAC_GLYPHS[key]) return MAC_GLYPHS[key] as string;
  const named = NAMED[key];
  if (named) return names[named];
  return /^f\d{1,2}$/.test(key) ? key.toUpperCase() : key.length === 1 ? key.toUpperCase() : key;
}

export function chordTokens(chord: Chord, platform: Platform, names: KeyNames): string[] {
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  const modifiers =
    platform === "mac"
      ? [ctrl && "⌃", chord.alt && "⌥", chord.shift && "⇧", meta && "⌘"]
      : [ctrl && names.ctrl, chord.alt && names.alt, chord.shift && names.shift, meta && names.meta];
  return [...modifiers.filter((m): m is string => typeof m === "string"), keyLabel(chord.key, platform, names)];
}

export const chordJoiner = (platform: Platform): "" | "+" => (platform === "mac" ? "" : "+");

const KEY_NAME_KEYS = {
  ctrl: "commands.key.ctrl",
  alt: "commands.key.alt",
  shift: "commands.key.shift",
  meta: "commands.key.meta",
  escape: "commands.key.escape",
  enter: "commands.key.enter",
  space: "commands.key.space",
  tab: "commands.key.tab",
  backspace: "commands.key.backspace",
  delete: "commands.key.delete",
  up: "commands.key.up",
  down: "commands.key.down",
  left: "commands.key.left",
  right: "commands.key.right",
  home: "commands.key.home",
  end: "commands.key.end",
  pageup: "commands.key.pageup",
  pagedown: "commands.key.pagedown",
} as const satisfies Readonly<Record<keyof KeyNames, MessageKey>>;

/** The key names in the current language (`commands.key.*`), for chordTokens. Consumed by Tasks 17b, 22 and 27. */
export function keyNames(t: Translate): KeyNames {
  return Object.fromEntries(Object.entries(KEY_NAME_KEYS).map(([id, key]) => [id, t(key)])) as KeyNames;
}

/** ARIA's aria-keyshortcuts form ("Control+K", "Meta+K"). */
export function ariaKeyShortcuts(chord: Chord, platform: Platform): string {
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  const key = chord.key === " " ? "Space" : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key.replace(/^arrow/, "Arrow").replace(/^./, (c) => c.toUpperCase());
  return [ctrl && "Control", chord.alt && "Alt", chord.shift && "Shift", meta && "Meta", key].filter(Boolean).join("+");
}
```

Add the key names to `catalog/commands.ts` (`commands.key.ctrl` "Ctrl"/"Ctrl", `commands.key.alt` "Alt"/"Alt", `commands.key.shift` "Shift"/"Maj", `commands.key.meta` "Meta"/"Méta", `commands.key.escape` "Esc"/"Échap", `commands.key.enter` "Enter"/"Entrée", `commands.key.space` "Space"/"Espace", `commands.key.tab` "Tab"/"Tab", `commands.key.backspace` "Backspace"/"Retour arrière", `commands.key.delete` "Del"/"Suppr", `commands.key.up` "Up"/"Haut", `commands.key.down` "Down"/"Bas", `commands.key.left` "Left"/"Gauche", `commands.key.right` "Right"/"Droite", `commands.key.home` "Home"/"Début", `commands.key.end` "End"/"Fin", `commands.key.pageup` "PgUp"/"Page préc.", `commands.key.pagedown` "PgDn"/"Page suiv."), with the keys that are the same word in French (`ctrl`, `alt`, `tab`) added to `IDENTICAL_IN_FR`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web/src/features/commands apps/web/src/i18n && pnpm knip`
Expected: PASS. Mutation checks: drop the `layoutUsable` condition on letters → "AZERTY A is not Q" fails; let a physical match ignore Shift (`symbol` without `byLayout`) → "a physical / never fires on Shift+/" fails; record `candidates.layout` first → "AZERTY Ctrl+1 is mod+1" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/features/commands apps/web/src/i18n
git commit -m "feat(commands): chords with physical-key matching and recording, and platform labels"
```

---

### Task 16b: Keybinding core, part 2 — `when` clauses, defaults, merge, conflicts, reserved chords

The `when` grammar is T3's (shared 282-414, depth ≤ 64, unknown identifiers are false); user rules replace the defaults of the commands they name (T3 `mergeWithDefaultKeybindings`, shared 451-469); browser-reserved chords are flagged (Review Focus 4). The default bindings carry the context keys of agreement 7 so Escape and every chord leave an extension's panel and an open menu alone (owner R3-6).

**Files:**
- Create: `apps/web/src/features/commands/when.ts`, `when.test.ts`, `defaults.ts`, `resolve.ts`, `resolve.test.ts`
- Modify: `apps/web/src/i18n/catalog/commands.ts` (command titles)

**Interfaces:**
- Consumes: Task 16a (`parseChord`, `matchesChord`, `chordId`, `Chord`, `KeyInput`, `Platform`); `KeybindingRule`, `KEY_NONE` (Task 12); `MessageKey` (Task 3).
- Produces:
  - `type WhenNode = { type: "id"; name: string } | { type: "not"; node: WhenNode } | { type: "and" | "or"; left: WhenNode; right: WhenNode }`; `type WhenError = { error: "empty" | "unexpected" | "unclosed" | "too_deep"; at: number }`; `parseWhen(text: string): WhenNode | WhenError`; `evaluateWhen(node, context: Readonly<Record<string, boolean>>): boolean`; `mentions(node, name: string): boolean`.
  - `type CommandGroup = "navigation" | "tabs" | "panes" | "session" | "agents" | "app"`; `interface CommandSpec { id: string; titleKey: MessageKey; titleVars?: Record<string, number>; group: CommandGroup }`; `COMMANDS: readonly CommandSpec[]`; `DEFAULT_KEYBINDINGS: readonly KeybindingRule[]`; `KNOWN_COMMANDS: ReadonlySet<string>`; `CONTEXT_KEYS = ["editableFocus", "dialogOpen", "overlayOpen", "panelFocus", "paletteOpen", "treeOpen", "sessionFocus", "mobile"] as const`.
  - `interface ResolvedRule { chord: Chord; command: string; when: WhenNode | null; whenText: string | null; source: "default" | "user"; index: number }`; `interface RuleIssue { index: number; problem: "key" | "when" | "command" }`; `mergeWithDefaults(defaults, user, known): { rules: ResolvedRule[]; issues: RuleIssue[] }`; `matchingCommands(event, rules, context, platform): string[]` (last matching rule first, de-duplicated); `conflictsOf(rules, platform): Map<number, string[]>`; `isReserved(chord, platform): boolean`.

**Rulings (pre-dispatch):**
- Default chords avoid what browsers keep: tab switching `Alt+Shift+←/→`, close tab `Alt+W` (both off inside text fields), split `Ctrl/⌘+\`, settings `Ctrl/⌘+,`; pi-web's `Esc`, `Ctrl+Alt+N`, `Alt+↑/↓`, `Ctrl+Alt+1..9` kept (owner M3-Q4 confirmed). [M3R69]
- A bare printable key (no Ctrl/Meta/Alt) never fires while a text field has focus unless its `when` names `editableFocus` (Orca `fileSearchClaimsTextKey`). [M3R70]
- Agreement 7 (owner R3-6): every default chord carries `!panelFocus`; `escape` also `!overlayOpen`, so Escape goes to an extension panel or an open menu/select/popover first and stops the run only when neither holds. `matchingCommands` also skips any rule while `panelFocus` holds unless its clause names `panelFocus`, so a user rule cannot take a key from a panel by accident. [M3R71]
- `mod+b` closes the tree drawer although the drawer is a modal: its clause is `!panelFocus && (!dialogOpen || treeOpen)` with a `treeOpen` context key (M3-RT-30). [M3R72]
- Reserved chords include `Ctrl+1..9` and, off Apple platforms, `Alt+1..9` (Firefox and Chrome on Linux/Windows switch tabs with them); the palette binds no digit chord (Task 22). [M3R73]
- `conflictsOf` is quadratic over at most defaults + 256 user rules (under 80 000 comparisons): accepted. [M3R74]

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/commands/when.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateWhen, mentions, parseWhen, type WhenNode } from "./when.ts";

const run = (text: string, context: Record<string, boolean>) => evaluateWhen(parseWhen(text) as WhenNode, context);

describe("when clauses (T3 grammar)", () => {
  it("evaluates !, &&, || and parentheses with ! > && > ||", () => {
    expect(run("a && !b", { a: true, b: false })).toBe(true);
    expect(run("a || b && c", { a: false, b: true, c: false })).toBe(false);
    expect(run("(a || b) && c", { a: true, c: true })).toBe(true);
    expect(run("unknownKey", {})).toBe(false);
    expect(run("true && !false", {})).toBe(true);
  });
  it("reports where a clause is broken", () => {
    expect(parseWhen("")).toEqual({ error: "empty", at: 0 });
    expect(parseWhen("a &&")).toEqual({ error: "unexpected", at: 4 });
    expect(parseWhen("(a")).toEqual({ error: "unclosed", at: 2 });
    expect(parseWhen("a & b")).toEqual({ error: "unexpected", at: 2 });
    expect(parseWhen("(".repeat(65) + "a" + ")".repeat(65))).toMatchObject({ error: "too_deep" });
  });
  it("knows which keys a clause reads", () => {
    expect(mentions(parseWhen("!editableFocus && dialogOpen") as WhenNode, "editableFocus")).toBe(true);
    expect(mentions(parseWhen("dialogOpen") as WhenNode, "editableFocus")).toBe(false);
  });
});
```

`apps/web/src/features/commands/resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { KeyInput } from "./keys.ts";
import { parseChord } from "./keys.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "./defaults.ts";
import { conflictsOf, isReserved, matchingCommands, mergeWithDefaults } from "./resolve.ts";

const known = new Set(["palette.toggle", "drawer.tree.toggle", "shortcuts.help", "tab.close"]);
const defaults = [
  { key: "mod+k", command: "palette.toggle" },
  { key: "mod+b", command: "drawer.tree.toggle", when: "!dialogOpen" },
  { key: "?", command: "shortcuts.help", when: "!editableFocus && !dialogOpen" },
];
const ev = (over: Partial<KeyInput>): KeyInput => ({ key: "k", code: "KeyK", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

describe("merge (T3 mergeWithDefaultKeybindings)", () => {
  it("replaces the defaults of every command a user rule names, and `none` unbinds", () => {
    const { rules } = mergeWithDefaults(defaults, [{ key: "mod+shift+p", command: "palette.toggle" }, { key: "none", command: "drawer.tree.toggle" }], known);
    expect(rules.map((r) => `${r.source}:${r.command}`)).toEqual(["default:shortcuts.help", "user:palette.toggle"]);
  });
  it("drops invalid user entries one by one and says which", () => {
    const { rules, issues } = mergeWithDefaults(defaults, [{ key: "mod+banana", command: "palette.toggle" }, { key: "mod+j", command: "nope.nothing" }, { key: "mod+j", command: "tab.close", when: "a &&" }, { key: "alt+w", command: "tab.close" }], known);
    expect(issues).toEqual([{ index: 0, problem: "key" }, { index: 1, problem: "command" }, { index: 2, problem: "when" }]);
    expect(rules.filter((r) => r.source === "user").map((r) => r.command)).toEqual(["tab.close"]);
  });
});

describe("matchingCommands", () => {
  const { rules } = mergeWithDefaults(defaults, [], known);
  it("puts the last matching rule first and honours when clauses", () => {
    expect(matchingCommands(ev({ ctrlKey: true, key: "b", code: "KeyB" }), rules, { dialogOpen: false }, "other")).toEqual(["drawer.tree.toggle"]);
    expect(matchingCommands(ev({ ctrlKey: true, key: "b", code: "KeyB" }), rules, { dialogOpen: true }, "other")).toEqual([]);
  });
  it("never fires inside a terminal-input panel unless the clause names panelFocus (agreement 7)", () => {
    const loose = mergeWithDefaults([], [{ key: "mod+k", command: "palette.toggle" }, { key: "mod+j", command: "tab.close", when: "panelFocus" }], known).rules;
    expect(matchingCommands(ev({ ctrlKey: true }), loose, { panelFocus: true }, "other")).toEqual([]);
    expect(matchingCommands(ev({ ctrlKey: true, key: "j", code: "KeyJ" }), loose, { panelFocus: true }, "other")).toEqual(["tab.close"]);
  });

  it("never fires a bare printable key in a text field unless its clause names editableFocus", () => {
    const loose = mergeWithDefaults([], [{ key: "?", command: "shortcuts.help" }], known).rules;
    expect(matchingCommands(ev({ key: "?", code: "Slash", shiftKey: true }), loose, { editableFocus: true }, "other")).toEqual([]);
    expect(matchingCommands(ev({ key: "?", code: "Slash", shiftKey: true }), loose, { editableFocus: false }, "other")).toEqual(["shortcuts.help"]);
  });
});

describe("the default bindings (agreement 7, M3-RT-30)", () => {
  const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
  it("keep every chord out of a terminal-input panel, and Escape out of open menus", () => {
    for (const rule of DEFAULT_KEYBINDINGS) expect(rule.when ?? "", rule.command).toContain("!panelFocus");
    const escape = (context: Record<string, boolean>) => matchingCommands(ev({ key: "Escape", code: "Escape" }), rules, context, "other");
    expect(escape({ sessionFocus: true })).toEqual(["session.stop"]);
    expect(escape({ sessionFocus: true, overlayOpen: true })).toEqual([]);
    expect(escape({ sessionFocus: true, panelFocus: true })).toEqual([]);
  });
  it("let mod+b close the tree drawer, which is itself a modal", () => {
    const modB = (context: Record<string, boolean>) => matchingCommands(ev({ ctrlKey: true, key: "b", code: "KeyB" }), rules, context, "other");
    expect(modB({ dialogOpen: true, treeOpen: true })).toEqual(["drawer.tree.toggle"]);
    expect(modB({ dialogOpen: true })).toEqual([]);
  });
});

describe("conflicts and reserved chords", () => {
  it("flags two rules on one chord when either has no clause or both clauses are equal", () => {
    const { rules } = mergeWithDefaults(defaults, [{ key: "ctrl+k", command: "tab.close" }], known);
    expect(conflictsOf(rules, "other").get(rules.length - 1)).toEqual(["palette.toggle"]);
    expect(conflictsOf(rules, "mac").size).toBe(0);
  });
  it("flags browser-reserved chords", () => {
    expect(isReserved(parseChord("mod+w") as never, "other")).toBe(true);
    expect(isReserved(parseChord("mod+t") as never, "mac")).toBe(true);
    expect(isReserved(parseChord("ctrl+tab") as never, "mac")).toBe(true);
    expect(isReserved(parseChord("mod+3") as never, "other")).toBe(true);
    expect(isReserved(parseChord("alt+3") as never, "other")).toBe(true);
    expect(isReserved(parseChord("mod+k") as never, "other")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/commands`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/web/src/features/commands/when.ts`:

```ts
export type WhenNode =
  | { readonly type: "id"; readonly name: string }
  | { readonly type: "not"; readonly node: WhenNode }
  | { readonly type: "and" | "or"; readonly left: WhenNode; readonly right: WhenNode };
export type WhenError = { readonly error: "empty" | "unexpected" | "unclosed" | "too_deep"; readonly at: number };

const MAX_DEPTH = 64;
const TOKEN = /\s*(\(|\)|!|&&|\|\||[A-Za-z_][A-Za-z0-9_.-]*)/y;

/** T3's grammar: identifiers, !, &&, ||, parentheses; ! binds tighter than &&, && tighter than ||. */
export function parseWhen(text: string): WhenNode | WhenError {
  if (text.trim() === "") return { error: "empty", at: 0 };
  const tokens: Array<{ value: string; at: number }> = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) {
      if (text.slice(start).trim() === "") break;
      return { error: "unexpected", at: start + (text.slice(start).length - text.slice(start).trimStart().length) };
    }
    tokens.push({ value: match[1] ?? "", at: TOKEN.lastIndex - (match[1] ?? "").length });
  }
  let i = 0;
  const fail = (error: WhenError["error"]): never => {
    throw { error, at: tokens[i]?.at ?? text.length } satisfies WhenError;
  };
  const unary = (depth: number): WhenNode => {
    if (depth > MAX_DEPTH) fail("too_deep");
    const token = tokens[i];
    if (!token) return fail("unexpected");
    if (token.value === "!") {
      i++;
      return { type: "not", node: unary(depth + 1) };
    }
    if (token.value === "(") {
      i++;
      const inner = or(depth + 1);
      if (tokens[i]?.value !== ")") fail("unclosed");
      i++;
      return inner;
    }
    if (/^[A-Za-z_]/.test(token.value)) {
      i++;
      return { type: "id", name: token.value };
    }
    return fail("unexpected");
  };
  const and = (depth: number): WhenNode => {
    let left = unary(depth);
    while (tokens[i]?.value === "&&") {
      i++;
      left = { type: "and", left, right: unary(depth) };
    }
    return left;
  };
  const or = (depth: number): WhenNode => {
    let left = and(depth);
    while (tokens[i]?.value === "||") {
      i++;
      left = { type: "or", left, right: and(depth) };
    }
    return left;
  };
  try {
    const node = or(0);
    if (i < tokens.length) fail("unexpected");
    return node;
  } catch (error) {
    if (error && typeof error === "object" && "error" in error) return error as WhenError;
    throw error;
  }
}

export function evaluateWhen(node: WhenNode, context: Readonly<Record<string, boolean>>): boolean {
  switch (node.type) {
    case "id":
      return node.name === "true" ? true : node.name === "false" ? false : context[node.name] === true;
    case "not":
      return !evaluateWhen(node.node, context);
    case "and":
      return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case "or":
      return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
  }
}

export function mentions(node: WhenNode, name: string): boolean {
  if (node.type === "id") return node.name === name;
  if (node.type === "not") return mentions(node.node, name);
  return mentions(node.left, name) || mentions(node.right, name);
}
```

(Check the positions the `when.test.ts` cases expect against this tokenizer and adjust the implementation, not the expectations: `"a &&"` fails at 4 — end of text —, `"(a"` at 2, `"a & b"` at 2.)

`apps/web/src/features/commands/defaults.ts` (imports `KeybindingRule` from `@pap/contracts` and `MessageKey` from `../../i18n/index.ts`): the catalogue below; titles are `commands.<id>` keys added to `catalog/commands.ts` in en and fr (e.g. `"commands.palette.toggle": "Open the command palette"` / `"Ouvrir la palette de commandes"`, `"commands.agent.goto": "Go to agent {n}"` / `"Aller à l'agent {n}"`):

```ts
/** Read by Task 17a's context; `panelFocus` and `overlayOpen` follow agreement 7 (owner R3-6), `treeOpen` M3-RT-30. */
export const CONTEXT_KEYS = ["editableFocus", "dialogOpen", "overlayOpen", "panelFocus", "paletteOpen", "treeOpen", "sessionFocus", "mobile"] as const;

export type CommandGroup = "navigation" | "tabs" | "panes" | "session" | "agents" | "app";

export interface CommandSpec {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly titleVars?: Readonly<Record<string, number>>;
  readonly group: CommandGroup;
}

export const COMMANDS: readonly CommandSpec[] = [
  { id: "palette.toggle", titleKey: "commands.palette.toggle", group: "navigation" },
  { id: "drawer.tree.toggle", titleKey: "commands.drawer.tree.toggle", group: "navigation" },
  { id: "drawer.inbox.toggle", titleKey: "commands.drawer.inbox.toggle", group: "navigation" },
  { id: "settings.open", titleKey: "commands.settings.open", group: "navigation" },
  { id: "shortcuts.help", titleKey: "commands.shortcuts.help", group: "app" },
  { id: "session.new", titleKey: "commands.session.new", group: "session" },
  { id: "session.stop", titleKey: "commands.session.stop", group: "session" },
  { id: "tab.next", titleKey: "commands.tab.next", group: "tabs" },
  { id: "tab.prev", titleKey: "commands.tab.prev", group: "tabs" },
  { id: "tab.close", titleKey: "commands.tab.close", group: "tabs" },
  { id: "pane.split", titleKey: "commands.pane.split", group: "panes" },
  { id: "pane.close", titleKey: "commands.pane.close", group: "panes" },
  { id: "agent.nextUnread", titleKey: "commands.agent.nextUnread", group: "agents" },
  { id: "agent.prevUnread", titleKey: "commands.agent.prevUnread", group: "agents" },
  // One title with the agent's position as a variable ("Go to agent {n}"), not nine keys.
  ...Array.from({ length: 9 }, (_, i): CommandSpec => ({ id: `agent.goto.${i + 1}`, titleKey: "commands.agent.goto", titleVars: { n: i + 1 }, group: "agents" })),
  { id: "appearance.cycleMode", titleKey: "commands.appearance.cycleMode", group: "app" },
  { id: "auth.signOut", titleKey: "commands.auth.signOut", group: "app" },
];

// pi-web's shortcuts (spec C §7.3) plus the shell's; chords browsers keep are avoided (Review Focus 4). Every chord
// stays out of an extension's terminal-input panel (`!panelFocus`); Escape also leaves an open menu, select or popover
// to Radix (`!overlayOpen`), so it stops the run only when neither holds (agreement 7, owner R3-6).
export const DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [
  { key: "mod+k", command: "palette.toggle", when: "!panelFocus" },
  { key: "mod+b", command: "drawer.tree.toggle", when: "!panelFocus && (!dialogOpen || treeOpen)" },
  { key: "mod+,", command: "settings.open", when: "!panelFocus && !dialogOpen" },
  { key: "?", command: "shortcuts.help", when: "!panelFocus && !editableFocus && !dialogOpen" },
  { key: "ctrl+alt+n", command: "session.new", when: "!panelFocus && !dialogOpen" },
  { key: "escape", command: "session.stop", when: "sessionFocus && !panelFocus && !overlayOpen && !dialogOpen && !paletteOpen" },
  { key: "alt+shift+arrowright", command: "tab.next", when: "!panelFocus && !editableFocus && !dialogOpen" },
  { key: "alt+shift+arrowleft", command: "tab.prev", when: "!panelFocus && !editableFocus && !dialogOpen" },
  { key: "alt+w", command: "tab.close", when: "!panelFocus && !editableFocus && !dialogOpen" },
  { key: "mod+\\", command: "pane.split", when: "!panelFocus && !dialogOpen && !mobile" },
  { key: "alt+arrowdown", command: "agent.nextUnread", when: "!panelFocus && !dialogOpen" },
  { key: "alt+arrowup", command: "agent.prevUnread", when: "!panelFocus && !dialogOpen" },
  ...Array.from({ length: 9 }, (_, i) => ({ key: `ctrl+alt+${i + 1}`, command: `agent.goto.${i + 1}`, when: "!panelFocus && !dialogOpen" })),
];

export const KNOWN_COMMANDS: ReadonlySet<string> = new Set(COMMANDS.map((command) => command.id));
```

`resolve.ts`:

```ts
import type { KeybindingRule } from "@pap/contracts";
import { chordId, matchesChord, parseChord, type Chord, type KeyInput, type Platform } from "./keys.ts";
import { evaluateWhen, mentions, parseWhen, type WhenNode } from "./when.ts";

export interface ResolvedRule {
  readonly chord: Chord;
  readonly command: string;
  readonly when: WhenNode | null;
  readonly whenText: string | null;
  readonly source: "default" | "user";
  /** Index in its source list (the user's JSON array for user rules). */
  readonly index: number;
}
export interface RuleIssue {
  readonly index: number;
  readonly problem: "key" | "when" | "command";
}

function resolveRule(rule: KeybindingRule, source: ResolvedRule["source"], index: number, known: ReadonlySet<string>): ResolvedRule | RuleIssue["problem"] {
  if (!known.has(rule.command)) return "command";
  const chord = parseChord(rule.key);
  if (!chord) return "key";
  const when = rule.when === undefined ? null : parseWhen(rule.when);
  if (when && "error" in when) return "when";
  return { chord, command: rule.command, when, whenText: rule.when ?? null, source, index };
}

/** T3: user rules replace the defaults of the commands they name (`none` replaces and binds nothing); later wins. */
export function mergeWithDefaults(defaults: readonly KeybindingRule[], user: readonly KeybindingRule[], known: ReadonlySet<string>): { rules: ResolvedRule[]; issues: RuleIssue[] } {
  const issues: RuleIssue[] = [];
  const userRules: ResolvedRule[] = [];
  const overridden = new Set<string>();
  user.forEach((rule, index) => {
    if (rule.key.trim().toLowerCase() === "none") {
      if (known.has(rule.command)) overridden.add(rule.command);
      else issues.push({ index, problem: "command" });
      return;
    }
    const resolved = resolveRule(rule, "user", index, known);
    if (typeof resolved === "string") issues.push({ index, problem: resolved });
    else {
      overridden.add(resolved.command);
      userRules.push(resolved);
    }
  });
  const kept = defaults
    .map((rule, index) => resolveRule(rule, "default", index, known))
    .filter((rule): rule is ResolvedRule => typeof rule !== "string" && !overridden.has(rule.command));
  return { rules: [...kept, ...userRules], issues };
}

const BARE_PRINTABLE = (chord: Chord) => !chord.ctrl && !chord.meta && !chord.alt && !chord.mod && [...chord.key].length === 1 && chord.key !== " ";

/** Commands whose rule matches, last rule first, each once. The dispatcher tries them in this order. */
export function matchingCommands(event: KeyInput, rules: readonly ResolvedRule[], context: Readonly<Record<string, boolean>>, platform: Platform): string[] {
  const out: string[] = [];
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i] as ResolvedRule;
    if (!matchesChord(rule.chord, event, platform)) continue;
    if (BARE_PRINTABLE(rule.chord) && context.editableFocus === true && !(rule.when && mentions(rule.when, "editableFocus"))) continue;
    // An extension's terminal-input panel owns its keys (agreement 7): a rule fires there only if its clause says so.
    if (context.panelFocus === true && !(rule.when && mentions(rule.when, "panelFocus"))) continue;
    if (rule.when && !evaluateWhen(rule.when, context)) continue;
    if (!out.includes(rule.command)) out.push(rule.command);
  }
  return out;
}

/** T3 keybindingConflictLabels: same chord, and either clause absent or both equal. Keyed by position in `rules`. */
export function conflictsOf(rules: readonly ResolvedRule[], platform: Platform): Map<number, string[]> {
  const out = new Map<number, string[]>();
  rules.forEach((a, i) => {
    const others = rules.filter((b, j) => j !== i && b.command !== a.command && chordId(a.chord, platform) === chordId(b.chord, platform) && (a.whenText === null || b.whenText === null || a.whenText === b.whenText));
    if (others.length > 0) out.set(i, others.map((b) => b.command));
  });
  return out;
}

const DIGITS = Array.from({ length: 9 }, (_, i) => String(i + 1));
const RESERVED: Readonly<Record<Platform, ReadonlySet<string>>> = {
  mac: new Set(["meta+w", "meta+t", "meta+n", "shift+meta+n", "shift+meta+t", "meta+q", "meta+l", "ctrl+tab", "ctrl+shift+tab", ...DIGITS.map((d) => `meta+${d}`)]),
  other: new Set(["ctrl+w", "ctrl+t", "ctrl+n", "ctrl+shift+n", "ctrl+shift+t", "ctrl+shift+w", "ctrl+l", "ctrl+tab", "ctrl+shift+tab", "ctrl+pageup", "ctrl+pagedown", "alt+f4", ...DIGITS.map((d) => `ctrl+${d}`), ...DIGITS.map((d) => `alt+${d}`)]),
};

/** Chords the browser or the OS usually keeps before the page sees them (Review Focus 4). */
export const isReserved = (chord: Chord, platform: Platform): boolean => RESERVED[platform].has(chordId(chord, platform));
```

(`rules` length is bounded: defaults plus at most 256 user rules, so the quadratic `conflictsOf` stays under 80 000 comparisons.)

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web/src/features/commands apps/web/src/i18n && pnpm knip`
Expected: PASS. Mutation checks: drop the bare-printable guard → "never fires a bare printable key in a text field" fails; drop the panel guard → "never fires inside a terminal-input panel" fails; remove `!overlayOpen` from Escape's default → "Escape out of open menus" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/features/commands apps/web/src/i18n
git commit -m "feat(commands): when clauses, default bindings with panel and overlay keys, merge and conflicts"
```

---

### Task 17a: Command registry, key dispatcher, `when` context, `useCommand`

One capture-phase `keydown` listener on `window` (Orca `src/renderer/src/app-shell/use-global-keybindings.ts`: one long-lived listener, bail-outs first) resolves the event to candidate commands; a registry maps each command to the handler of whoever mounted it (Orca `app-command-handlers.ts`: a handler returns false to decline, so an unclaimed chord falls through to the browser and the focused element). The same registry runs commands from the palette. User rules load from and save to the account `keybindings` document (Task 12) exactly like the appearance. `?` opens the shortcuts help (pw `components/ShortcutsDialog.tsx`), built from the effective rules, so it is never out of date.

This part holds the registry, the context and the dispatcher; Task 17b adds the user keybindings and the shortcuts help.

**Files:**
- Create: `apps/web/src/features/commands/registry.ts`, `registry.test.ts`, `context.ts`, `dispatcher.ts`, `dispatcher.test.ts`, `use-command.ts`, `use-command.test.tsx`
- Modify: `apps/web/src/testing/dom.ts` (`Mounted` gains `rerender(element)`, as Task 4 gives the `packages/ui` copy; additive, listed in the conflict table)

**Interfaces:**
- Consumes: Task 16b (`matchingCommands`, `ResolvedRule`, `CONTEXT_KEYS`), Task 16a (`Platform`); `cancelsComposition` (Task 6).
- Produces:
  - `type CommandHandler = () => boolean | void` (false = declined); `registerCommand(id: string, handler: CommandHandler): () => void` (a stack per id, the latest registration answers; the returned function removes exactly that registration); `runCommand(id: string): boolean`; `hasCommand(id: string): boolean`; `onRegistryChange(listener): () => void`.
  - `useCommand(id: string, handler: CommandHandler, enabled?: boolean): void` (latest-callback ref, registered in an effect).
  - `interface ShellContext { mobile: boolean; treeOpen: boolean }`; `readContext(doc: Document, shell: ShellContext): Record<ContextKey, boolean>` — `editableFocus` = focus inside `input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]` (T3 `lib/editableFocus.ts`); `dialogOpen` = a `[data-pap-modal][data-state="open"]` exists; `overlayOpen` = an open `[role="menu"]`, `[role="listbox"]` or Radix popper content that is not a tooltip; `panelFocus` = focus inside `[data-terminal-input]` (M2's CustomPanel carries it, agreement 7); `paletteOpen` = `[data-command-palette]` exists; `sessionFocus` = focus inside `[data-pane-kind="session"]`; `mobile`, `treeOpen` from the shell.
  - `installDispatcher(deps: { win: Window; platform: Platform; rules(): readonly ResolvedRule[]; shell(): ShellContext }): () => void`.

**Rulings (pre-dispatch):**
- The dispatcher ignores auto-repeat for every command (T3 `if (event.repeat) return`). [M3R75]
- The dispatcher is one capture-phase listener on `window`, so it runs before any element handler; that is why the context, not `stopPropagation` in a panel, keeps Escape and chords away from extension panels and open menus (agreement 7, M3-RT-16). A tooltip is not an overlay. [M3R76]
- Before M2's session screen registers `session.stop` (post-merge P3), Escape is unclaimed and keeps its browser meaning: accepted interim. [M3R77]

- [ ] **Step 1: Write the failing tests**

`registry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { hasCommand, onRegistryChange, registerCommand, runCommand } from "./registry.ts";

describe("command registry (Orca app-command-handlers)", () => {
  it("lets the latest registration answer and re-exposes the earlier one when it leaves", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerCommand("x.one", first);
    const offSecond = registerCommand("x.one", second);
    expect(runCommand("x.one")).toBe(true);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
    offSecond();
    runCommand("x.one");
    expect(first).toHaveBeenCalledOnce();
    offFirst();
    expect(hasCommand("x.one")).toBe(false);
  });

  it("reports a declined or unknown command as unclaimed", () => {
    const off = registerCommand("x.two", () => false);
    expect(runCommand("x.two")).toBe(false);
    expect(runCommand("x.none")).toBe(false);
    off();
  });

  it("tells listeners about registrations and removals; a second removal changes nothing", () => {
    const listener = vi.fn();
    const stop = onRegistryChange(listener);
    const off = registerCommand("x.three", () => {});
    off();
    off();
    stop();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
```

`dispatcher.test.ts` (`// @vitest-environment happy-dom`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDispatcher } from "./dispatcher.ts";
import { registerCommand } from "./registry.ts";
import { mergeWithDefaults } from "./resolve.ts";

const known = new Set(["palette.toggle", "shortcuts.help", "drawer.tree.toggle", "session.stop"]);
const { rules } = mergeWithDefaults(
  [
    { key: "mod+k", command: "palette.toggle", when: "!panelFocus" },
    { key: "mod+b", command: "drawer.tree.toggle", when: "!panelFocus && (!dialogOpen || treeOpen)" },
    { key: "?", command: "shortcuts.help", when: "!panelFocus && !editableFocus && !dialogOpen" },
    { key: "escape", command: "session.stop", when: "sessionFocus && !panelFocus && !overlayOpen && !dialogOpen && !paletteOpen" },
  ],
  [],
  known,
);
const shell = { mobile: false, treeOpen: false };
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

let stop: () => void;
let cleanup: Array<() => void> = [];
beforeEach(() => {
  stop = installDispatcher({ win: window, platform: "other", rules: () => rules, shell: () => shell });
});
afterEach(() => {
  stop();
  cleanup.forEach((fn) => fn());
  cleanup = [];
  document.body.innerHTML = "";
});

describe("key dispatcher", () => {
  it("runs the command's handler and keeps the key from the page", () => {
    const handler = vi.fn();
    cleanup.push(registerCommand("palette.toggle", handler));
    const event = press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a key alone when nobody claims it, or the handler declines", () => {
    expect(press({ key: "k", code: "KeyK", ctrlKey: true }).defaultPrevented).toBe(false);
    cleanup.push(registerCommand("palette.toggle", () => false));
    expect(press({ key: "k", code: "KeyK", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("does nothing during a composition, for auto-repeat, inside the recorder or after another handler", () => {
    const handler = vi.fn();
    cleanup.push(registerCommand("palette.toggle", handler));
    press({ key: "k", code: "KeyK", ctrlKey: true, isComposing: true });
    press({ key: "k", code: "KeyK", ctrlKey: true, repeat: true });
    const recorder = document.createElement("button");
    recorder.setAttribute("data-shortcut-recorder", "");
    document.body.append(recorder);
    press({ key: "k", code: "KeyK", ctrlKey: true }, recorder);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reads the context from the page: a modal blocks mod+b, a text field blocks ?", () => {
    const tree = vi.fn();
    const help = vi.fn();
    cleanup.push(registerCommand("drawer.tree.toggle", tree), registerCommand("shortcuts.help", help));
    const modal = document.createElement("div");
    modal.setAttribute("data-pap-modal", "");
    modal.setAttribute("data-state", "open");
    document.body.append(modal);
    press({ key: "b", code: "KeyB", ctrlKey: true });
    modal.remove();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    press({ key: "?", code: "Slash", shiftKey: true }, input);
    expect([tree.mock.calls.length, help.mock.calls.length]).toEqual([0, 0]);
    input.blur();
    press({ key: "?", code: "Slash", shiftKey: true });
    expect(help).toHaveBeenCalledOnce();
  });

  it("leaves a key another handler already took (defaultPrevented) alone", () => {
    const handler = vi.fn();
    cleanup.push(registerCommand("palette.toggle", handler));
    // Listeners on one target run in registration order: put a capture listener before the dispatcher.
    stop();
    const first = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", first, { capture: true });
    stop = installDispatcher({ win: window, platform: "other", rules: () => rules, shell: () => shell });
    press({ key: "k", code: "KeyK", ctrlKey: true });
    window.removeEventListener("keydown", first, { capture: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("gives Escape to an open menu or select, and to an extension's panel; stops the run otherwise (agreement 7)", () => {
    const stopRun = vi.fn();
    cleanup.push(registerCommand("session.stop", stopRun));
    const pane = document.createElement("section");
    pane.setAttribute("data-pane-kind", "session");
    const button = document.createElement("button");
    const panel = document.createElement("div");
    panel.setAttribute("data-terminal-input", "");
    const field = document.createElement("textarea");
    panel.append(field);
    pane.append(button, panel);
    document.body.append(pane);
    button.focus();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    expect(press({ key: "Escape", code: "Escape" }, button).defaultPrevented).toBe(false);
    menu.remove();
    field.focus();
    expect(press({ key: "Escape", code: "Escape" }, field).defaultPrevented).toBe(false);
    expect(press({ key: "k", code: "KeyK", ctrlKey: true }, field).defaultPrevented).toBe(false);
    button.focus();
    expect(press({ key: "Escape", code: "Escape" }, button).defaultPrevented).toBe(true);
    expect(stopRun).toHaveBeenCalledOnce();
  });

  it("ignores an open tooltip when it decides whether an overlay is open", () => {
    const stopRun = vi.fn();
    cleanup.push(registerCommand("session.stop", stopRun));
    const pane = document.createElement("section");
    pane.setAttribute("data-pane-kind", "session");
    const button = document.createElement("button");
    pane.append(button);
    const tip = document.createElement("div");
    tip.setAttribute("data-radix-popper-content-wrapper", "");
    tip.innerHTML = '<div><span role="tooltip">Stop</span></div>';
    document.body.append(pane, tip);
    button.focus();
    press({ key: "Escape", code: "Escape" }, button);
    expect(stopRun).toHaveBeenCalledOnce();
  });

  it("stops listening when stopped", () => {
    const handler = vi.fn();
    cleanup.push(registerCommand("palette.toggle", handler));
    stop();
    press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    stop = () => {};
  });
});
```

`use-command.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "../../testing/dom.ts";
import { hasCommand, runCommand } from "./registry.ts";
import { useCommand } from "./use-command.ts";

function Probe({ handler, enabled = true }: { handler: () => boolean | void; enabled?: boolean }) {
  useCommand("x.probe", handler, enabled);
  return null;
}

describe("useCommand", () => {
  it("registers while mounted and enabled, and always calls the latest handler", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const page = await mount(<Probe handler={first} />);
    expect(hasCommand("x.probe")).toBe(true);
    await page.rerender(<Probe handler={second} />);
    runCommand("x.probe");
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
    await page.unmount();
    expect(hasCommand("x.probe")).toBe(false);
    const off = await mount(<Probe handler={first} enabled={false} />);
    expect(hasCommand("x.probe")).toBe(false);
    await off.unmount();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/commands`
Expected: FAIL.

- [ ] **Step 3: Implement**

`registry.ts`:

```ts
export type CommandHandler = () => boolean | void;

// One stack per command id; entries exist only while the component that registered them is mounted.
const handlers = new Map<string, Array<{ readonly handler: CommandHandler }>>();
const listeners = new Set<() => void>();
const changed = () => [...listeners].forEach((listener) => listener());

export function registerCommand(id: string, handler: CommandHandler): () => void {
  const entry = { handler };
  const stack = handlers.get(id) ?? [];
  stack.push(entry);
  handlers.set(id, stack);
  changed();
  return () => {
    const current = handlers.get(id);
    if (!current) return;
    const index = current.indexOf(entry);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) handlers.delete(id);
    changed();
  };
}

/** True when the latest handler claimed the command (it returned anything but false). */
export function runCommand(id: string): boolean {
  const entry = handlers.get(id)?.at(-1);
  return entry ? entry.handler() !== false : false;
}

export const hasCommand = (id: string): boolean => (handlers.get(id)?.length ?? 0) > 0;

export function onRegistryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
```

`context.ts`:

```ts
import { CONTEXT_KEYS } from "./defaults.ts";

export interface ShellContext {
  readonly mobile: boolean;
  readonly treeOpen: boolean;
}

const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]';

/** Radix popper content (menus, selects, popovers) or a menu or listbox, but never a mere tooltip. */
function overlayOpen(doc: Document): boolean {
  if (doc.querySelector('[role="menu"], [role="listbox"]')) return true;
  return [...doc.querySelectorAll("[data-radix-popper-content-wrapper]")].some((wrapper) => wrapper.querySelector('[role="tooltip"]') === null);
}

/** The `when` context of one key event, read from the page (T3 lib/editableFocus.ts; agreement 7). */
export function readContext(doc: Document, shell: ShellContext): Record<(typeof CONTEXT_KEYS)[number], boolean> {
  const active = doc.activeElement instanceof Element ? doc.activeElement : null;
  return {
    editableFocus: active?.closest(EDITABLE) != null,
    dialogOpen: doc.querySelector('[data-pap-modal][data-state="open"]') !== null,
    overlayOpen: overlayOpen(doc),
    panelFocus: active?.closest("[data-terminal-input]") != null,
    paletteOpen: doc.querySelector("[data-command-palette]") !== null,
    treeOpen: shell.treeOpen,
    sessionFocus: active?.closest('[data-pane-kind="session"]') != null,
    mobile: shell.mobile,
  };
}
```

`dispatcher.ts`:

```ts
import { cancelsComposition } from "@pap/ui";
import { readContext, type ShellContext } from "./context.ts";
import type { Platform } from "./keys.ts";
import { runCommand } from "./registry.ts";
import { matchingCommands, type ResolvedRule } from "./resolve.ts";

export interface DispatcherDeps {
  readonly win: Window;
  readonly platform: Platform;
  rules(): readonly ResolvedRule[];
  shell(): ShellContext;
}

/** One capture-phase listener for the whole app (Orca use-global-keybindings.ts). Returns its removal. */
export function installDispatcher(deps: DispatcherDeps): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || cancelsComposition(event) || event.key === "Process") return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-shortcut-recorder]")) return;
    const context = readContext(deps.win.document, deps.shell());
    for (const command of matchingCommands(event, deps.rules(), context, deps.platform)) {
      if (runCommand(command)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  };
  deps.win.addEventListener("keydown", onKeyDown, { capture: true });
  return () => deps.win.removeEventListener("keydown", onKeyDown, { capture: true });
}
```

`use-command.ts`:

```ts
import { useEffect, useRef } from "react";
import { registerCommand, type CommandHandler } from "./registry.ts";

/** Registers a command handler while mounted and `enabled`; the registry always calls the latest `handler`. */
export function useCommand(id: string, handler: CommandHandler, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => (enabled ? registerCommand(id, () => latest.current()) : undefined), [id, enabled]);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web/src/features/commands && pnpm lint && pnpm knip`
Expected: PASS. Mutation checks: remove the `event.repeat` bail-out → the auto-repeat case fails; remove the `defaultPrevented` bail-out → "leaves a key another handler already took" fails; make `overlayOpen` count tooltips → "ignores an open tooltip" fails; drop `panelFocus` from the context → the Escape-in-a-panel case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/features/commands apps/web/src/testing/dom.ts
git commit -m "feat(commands): command registry, one key dispatcher with panel and overlay context, useCommand"
```

---

### Task 17b: User keybindings (account document) and the shortcuts help

User rules load from and save to the account `keybindings` document (Task 12) through the same compare-and-set engine as the appearance (`createAccountDocument`, Task 15): a list document is one field, so a conflict keeps this device's list if it changed here and the server's otherwise. The local cache is read field by field: the valid rules survive, the rest are dropped and reported (M3-RT-29). `?` opens the shortcuts help (pw `components/ShortcutsDialog.tsx`), built from the effective rules, so it is never out of date; it is a lazy chunk mounted by the shell (Task 21, owner R3-5).

**Files:**
- Create: `apps/web/src/features/commands/keybindings-store.ts`, `keybindings-store.test.ts`, `ShortcutsHelp.tsx`, `ShortcutsHelp.test.tsx`, `index.ts`
- Modify: `apps/web/src/i18n/catalog/commands.ts`, `apps/web/src/main.tsx` (`startKeybindings()` next to `startAppearance()`)

**Interfaces:**
- Consumes: Task 16b (`mergeWithDefaults`, `DEFAULT_KEYBINDINGS`, `KNOWN_COMMANDS`, `COMMANDS`), Task 16a (`chordTokens`, `chordJoiner`, `keyNames`, `Platform`); `createAccountDocument`, `AccountStatus` (Task 15); `KeybindingRule` (Task 12); `reportClientIssue` (Task 3); `Dialog`, `Kbd` (Tasks 5, 8).
- Produces:
  - `parseRules(value: unknown): KeybindingRule[]` (the valid entries of the first 256; reports `keybindings_invalid` when it dropped any).
  - `useKeybindingsStore` state `{ user: readonly KeybindingRule[]; rules: readonly ResolvedRule[]; issues: readonly RuleIssue[]; status: AccountStatus; setUser(next): void; replaceFromServer(next): void; setStatus(status): void }`.
  - `startKeybindings(): { stop(): void }` (creates the account document and follows the store), `syncKeybindings(rpc: Runtime["rpc"]): Promise<void>`.
  - `ShortcutsHelp({ open: boolean; onOpenChange(open: boolean): void; platform: Platform })` (also the default export, for `lazy`).
  - `features/commands/index.ts` re-exports only `startKeybindings` now (main.tsx imports it); Tasks 19a, 19b, 21, 22 and 27 add the names they import (M3-RT-13).

**Rulings (pre-dispatch):**
- Keybindings use the appearance's compare-and-set engine unchanged (owner R3-4): hold until loaded, never save after a failed load, one retry on conflict, one save at a time, R105 for every other failure. The list is one field: a conflict keeps this device's list when it changed here, the server's otherwise. [M3R78]
- The local cache (`pap.keybindings.v1`) and the server copy are read through `parseRules`: valid entries survive, at most 256 (the contract's cap), the rest are dropped with one `keybindings_invalid` line; a newer pap's longer list would be cut at the next save from this version (accepted: no such version exists). [M3R79]
- The shortcuts help is a lazy chunk (owner R3-5); Task 21 mounts it behind `LazyBoundary`. [M3R80]

- [ ] **Step 1: Write the failing tests**

`keybindings-store.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { parseRules, startKeybindings, syncKeybindings, useKeybindingsStore } from "./keybindings-store.ts";

const report = vi.hoisted(() => ({ reportClientIssue: vi.fn() }));
vi.mock("../../lib/report.ts", () => report);

const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function server(get: Array<() => unknown>, set: Array<() => unknown> = []) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    const step = (method === "settings.get" ? get : set).shift();
    if (!step) throw new Error(`no scripted answer for ${method}`);
    return step();
  });
  return { rpc: { call } as never, sets: () => calls.filter((c) => c.method === "settings.set").map((c) => c.params) };
}

let started: { stop(): void } | null = null;
beforeEach(() => {
  vi.useFakeTimers(); // the document's 400 ms debounce
  localStorage.clear();
  useKeybindingsStore.getState().setUser([]);
  report.reportClientIssue.mockClear();
});
afterEach(() => {
  started?.stop();
  started = null;
  vi.useRealTimers();
});

describe("keybindings store", () => {
  it("replaces the defaults of a command the user rebinds, and puts user rules last", () => {
    useKeybindingsStore.getState().setUser([{ key: "mod+shift+p", command: "palette.toggle" }]);
    const rules = useKeybindingsStore.getState().rules;
    expect(rules.filter((r) => r.command === "palette.toggle").map((r) => `${r.source}:${r.chord.key}`)).toEqual(["user:p"]);
    expect(rules.at(-1)?.command).toBe("palette.toggle");
  });

  it("reports invalid entries once and keeps the valid ones", () => {
    useKeybindingsStore.getState().setUser([{ key: "mod+banana", command: "palette.toggle" }, { key: "alt+p", command: "palette.toggle" }]);
    expect(useKeybindingsStore.getState().issues).toEqual([{ index: 0, problem: "key" }]);
    expect(report.reportClientIssue).toHaveBeenCalledExactlyOnceWith("keybindings_invalid");
  });

  it("reads a hand-edited local cache field by field (M3-RT-29)", () => {
    expect(parseRules([{ key: "alt+p", command: "palette.toggle" }, "nope", { key: 3 }, { key: "mod+k", command: "rm -rf" }])).toEqual([{ key: "alt+p", command: "palette.toggle" }]);
    expect(report.reportClientIssue).toHaveBeenCalledWith("keybindings_invalid");
    expect(parseRules(Array.from({ length: 300 }, () => ({ key: "mod+k", command: "palette.toggle" })))).toHaveLength(256);
    expect(parseRules({ not: "a list" })).toEqual([]);
  });

  it("takes the server's rules once connected", async () => {
    started = startKeybindings();
    await syncKeybindings(server([() => ({ value: [{ key: "alt+p", command: "palette.toggle" }], revision: 1 })]).rpc);
    expect([useKeybindingsStore.getState().user, useKeybindingsStore.getState().status]).toEqual([[{ key: "alt+p", command: "palette.toggle" }], "saved"]);
  });

  it("sends a change made before the load, from the server's revision", async () => {
    started = startKeybindings();
    useKeybindingsStore.getState().setUser([{ key: "alt+o", command: "palette.toggle" }]);
    await vi.advanceTimersByTimeAsync(400);
    const s = server([() => ({ value: [{ key: "alt+q", command: "palette.toggle" }], revision: 3 })], [() => ({ revision: 4 })]);
    await syncKeybindings(s.rpc);
    await drain();
    expect(useKeybindingsStore.getState().user).toEqual([{ key: "alt+o", command: "palette.toggle" }]);
    expect(s.sets()).toEqual([{ key: "keybindings", value: [{ key: "alt+o", command: "palette.toggle" }], baseRevision: 3 }]);
  });

  it("keeps its own rules for an older daemon and never saves to it", async () => {
    started = startKeybindings();
    useKeybindingsStore.getState().setUser([{ key: "alt+o", command: "palette.toggle" }]);
    const s = server([() => Promise.reject(new RpcError("unknown_method"))]);
    await syncKeybindings(s.rpc);
    await vi.advanceTimersByTimeAsync(1000);
    expect([useKeybindingsStore.getState().user.length, s.sets()]).toEqual([1, []]);
  });
});
```

`ShortcutsHelp.test.tsx`: opened, it lists each command that has an effective chord with its title and its `Kbd` tokens (`Ctrl` `K` for `palette.toggle` on "other"), grouped under `commands.group.*` headings; a command whose only rule is unbound (`none`) is not listed.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/commands`
Expected: FAIL.

- [ ] **Step 3: Implement**

`keybindings-store.ts` (the pieces as in Task 15, one file: keybindings have no device scope):

```ts
import { KeybindingRule } from "@pap/contracts";
import { create } from "zustand";
import { createAccountDocument, type AccountStatus } from "../../lib/account-setting.ts";
import { reportClientIssue } from "../../lib/report.ts";
import type { Runtime } from "../../runtime/index.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "./defaults.ts";
import { mergeWithDefaults, type ResolvedRule, type RuleIssue } from "./resolve.ts";

const CACHE_KEY = "pap.keybindings.v1";
const MAX_RULES = 256;

/** Field by field for a list (M3-RT-29): the valid rules among the first 256; one report when any was dropped. */
export function parseRules(value: unknown): KeybindingRule[] {
  if (!Array.isArray(value)) return [];
  const rules: KeybindingRule[] = [];
  for (const entry of value.slice(0, MAX_RULES)) {
    const parsed = KeybindingRule.safeParse(entry);
    if (parsed.success) rules.push(parsed.data);
  }
  if (rules.length !== value.length) reportClientIssue("keybindings_invalid");
  return rules;
}

function readCache(): KeybindingRule[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw === null ? [] : parseRules(JSON.parse(raw));
  } catch {
    reportClientIssue("keybindings_invalid"); // unreadable JSON or a locked-down storage: the defaults apply
    return [];
  }
}
function writeCache(rules: readonly KeybindingRule[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(rules));
  } catch {
    reportClientIssue("storage_refused");
  }
}

interface KeybindingsState {
  readonly user: readonly KeybindingRule[];
  readonly rules: readonly ResolvedRule[];
  readonly issues: readonly RuleIssue[];
  readonly status: AccountStatus;
  setUser(next: readonly KeybindingRule[]): void;
  replaceFromServer(next: readonly KeybindingRule[]): void;
  setStatus(status: AccountStatus): void;
}

const resolve = (user: readonly KeybindingRule[]) => mergeWithDefaults(DEFAULT_KEYBINDINGS, user, KNOWN_COMMANDS);

export const useKeybindingsStore = create<KeybindingsState>()((set) => {
  const user = readCache();
  return {
    user,
    ...resolve(user),
    status: "local",
    setUser: (next) => {
      writeCache(next);
      const resolved = resolve(next);
      if (resolved.issues.length > 0) reportClientIssue("keybindings_invalid");
      set({ user: next, ...resolved });
    },
    replaceFromServer: (next) => {
      writeCache(next);
      set({ user: next, ...resolve(next) });
    },
    setStatus: (status) => set({ status }),
  };
});

let active: { stop(): void } | null = null;
let sync: ((rpc: Runtime["rpc"]) => Promise<void>) | null = null;

/** Creates the account document and follows the store (once, before the first render, like startAppearance). */
export function startKeybindings(): { stop(): void } {
  active?.stop();
  let adopting = false;
  const doc = createAccountDocument<readonly KeybindingRule[]>({
    key: "keybindings",
    write: (value, baseRevision) => ({ key: "keybindings", value: [...value], baseRevision }),
    parse: parseRules,
    changed: (previous, next) => (JSON.stringify(previous) === JSON.stringify(next) ? [] : ["rules"]),
    merge: (server, local, dirty) => (dirty.has("rules") ? local : server),
    local: () => useKeybindingsStore.getState().user,
    adopt: (next) => {
      adopting = true;
      try {
        useKeybindingsStore.getState().replaceFromServer(next);
      } finally {
        adopting = false;
      }
    },
    onStatus: (status) => useKeybindingsStore.getState().setStatus(status),
  });
  const unsubscribe = useKeybindingsStore.subscribe((state, previous) => {
    if (state.user !== previous.user && !adopting) doc.change(previous.user, state.user);
  });
  sync = (rpc) => doc.sync(rpc);
  active = {
    stop() {
      unsubscribe();
      doc.dispose();
      sync = null;
      active = null;
    },
  };
  return active;
}

/** Each time the socket opens (Task 19b). */
export function syncKeybindings(rpc: Runtime["rpc"]): Promise<void> {
  return sync?.(rpc) ?? Promise.resolve();
}

// A hot update replaces this module: the old document must not keep its subscription (R125).
if (import.meta.hot) import.meta.hot.dispose(() => active?.stop());
```

`ShortcutsHelp.tsx` lists `COMMANDS` grouped by `group`, each with `chordTokens` of its last effective rule, `keyNames(useT())` and `chordJoiner(platform)`, in a `Dialog` titled `t("commands.help.title")` ("Keyboard shortcuts" / "Raccourcis clavier"); it is also the module's default export (for `lazy`).

`index.ts`: `export { startKeybindings } from "./keybindings-store.ts";` (later tasks add their names). `main.tsx`: call `startKeybindings()` right after `startAppearance()`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web/src/features/commands && pnpm lint && pnpm knip`
Expected: PASS. Mutation checks: read the cache with `KeybindingRules.safeParse` all-or-nothing → "reads a hand-edited local cache field by field" fails; drop the `adopting` flag → "takes the server's rules once connected" fails (the adopted list goes straight back as a save, so the status is `saving`, not `saved`).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/features/commands apps/web/src/i18n apps/web/src/main.tsx
git commit -m "feat(commands): account keybindings with compare-and-set sync, and the shortcuts help"
```

---
# Phase 6 — The shell (decision 25)

### Task 18: Workspace model — open items, split panes, persistence, URL mapping

DESIGN.md §8: the tabs bar shows what is open (closing a tab deletes nothing); panes split with a 320 px minimum; the layout is remembered (per lane once lanes exist, M9; per open item until then). The model is Orca's (`src/shared/tab-types.ts`, `src/shared/workspace-layout/tab-group-layout-tree.ts`): items addressed by a stable key, split ratios part of the persisted model, an unchanged ratio returns the same object so no subscriber wakes. M3 needs one split per tab (two panes); the persisted shape is versioned (`pap.workspace.v1`) so M8/M9 can grow it into Orca's binary tree with a migration.

**Files:**
- Create: `apps/web/src/features/workspace/model.ts`, `model.test.ts`, `item-path.ts`, `item-path.test.ts`, `persist.ts`, `persist.test.ts`, `workspace-store.ts`, `workspace-store.test.ts` (no `index.ts` yet: Task 19a creates it with the names the shell imports, M3-RT-13)

**Interfaces:**
- Produces:
  - `SETTINGS_SECTIONS = ["appearance", "shortcuts", "language", "account"] as const`, `type SettingsSection`.
  - `type ItemRef = { kind: "home" } | { kind: "session"; id: string } | { kind: "settings"; section: SettingsSection } | { kind: "dev-ui" }`; `interface Split { item: ItemRef; ratio: number }`; `interface Tab { key: string; item: ItemRef; split: Split | null }`; `interface Workspace { tabs: readonly Tab[]; active: string | null }`; `EMPTY_WORKSPACE`; `MAX_TABS = 24`; `MIN_RATIO = 0.15`; `MAX_RATIO = 0.85`.
  - `itemKey(item): string` (`home`, `session:<id>`, `settings` — one settings tab whatever the section —, `dev-ui`); `openItem(ws, item)`; `closeTab(ws, key)`; `cycleTab(ws, step: 1 | -1)`; `splitTab(ws, key, item)`; `unsplitTab(ws, key)`; `setSplitRatio(ws, key, ratio)`; `activeTab(ws): Tab | null`.
  - `itemFromPath(pathname: string, devUi: boolean): ItemRef | null`; `pathOfItem(item): string`.
  - `WORKSPACE_KEY = "pap.workspace.v1"`; `parseWorkspace(raw: string | null, devUi: boolean): Workspace`; `serializeWorkspace(ws): string`.
  - `useWorkspaceStore` state `{ ws: Workspace; open(item): void; close(key): void; cycle(step): void; split(key, item): void; unsplit(key): void; setRatio(key, ratio): void }` (persists every change; a refused write calls `reportClientIssue("storage_refused")`).

**Rulings (pre-dispatch):**
- At 24 open tabs, opening another closes the oldest inactive tab (nothing is deleted: the item is still in the drawer and ⌘K; DESIGN §8). [M3R81]
- Only the active tab is mounted; switching tabs remounts the session screen (its state lives in M2's store; one feed per session id, R125); the resubscribe cost stays within the session-open payload budget. [M3R82]
- The layout is remembered per open item until lanes exist (M9; DESIGN says per lane). [M3R83]
- `workspace-store.ts` has its own test: a refused `localStorage` write keeps the in-memory workspace and reports `storage_refused` once (checklist: errors are never silent). [M3R84]

- [ ] **Step 1: Write the failing tests**

`model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activeTab, closeTab, cycleTab, EMPTY_WORKSPACE, itemKey, MAX_TABS, openItem, setSplitRatio, splitTab, unsplitTab, type Workspace } from "./model.ts";

const session = (id: string) => ({ kind: "session", id }) as const;
const keys = (ws: Workspace) => ws.tabs.map((t) => t.key);

describe("workspace model", () => {
  it("opens an item once and activates it again later", () => {
    let ws = openItem(EMPTY_WORKSPACE, session("a"));
    ws = openItem(ws, { kind: "home" });
    ws = openItem(ws, session("a"));
    expect([keys(ws), ws.active]).toEqual([["session:a", "home"], "session:a"]);
  });

  it("keeps one settings tab and moves it to the requested section", () => {
    let ws = openItem(EMPTY_WORKSPACE, { kind: "settings", section: "appearance" });
    ws = openItem(ws, { kind: "settings", section: "shortcuts" });
    expect(ws.tabs).toEqual([{ key: "settings", item: { kind: "settings", section: "shortcuts" }, split: null }]);
  });

  it("closes the oldest inactive tab when a 25th item opens", () => {
    let ws = EMPTY_WORKSPACE;
    for (let i = 0; i < MAX_TABS; i++) ws = openItem(ws, session(String(i)));
    ws = openItem(ws, session("new"));
    expect(ws.tabs).toHaveLength(MAX_TABS);
    expect(keys(ws)[0]).toBe("session:1");
    expect(ws.active).toBe("session:new");
  });

  it("activates the right neighbour, then the left one, when the active tab closes", () => {
    let ws = [session("a"), session("b"), session("c")].reduce(openItem, EMPTY_WORKSPACE);
    ws = closeTab(openItem(ws, session("b")), "session:b");
    expect(ws.active).toBe("session:c");
    ws = closeTab(ws, "session:c");
    expect(ws.active).toBe("session:a");
    expect(closeTab(ws, "session:a")).toEqual(EMPTY_WORKSPACE);
  });

  it("cycles with wrap-around", () => {
    const ws = [session("a"), session("b")].reduce(openItem, EMPTY_WORKSPACE);
    expect(cycleTab(ws, 1).active).toBe("session:a");
    expect(cycleTab(ws, -1).active).toBe("session:a");
  });

  it("splits with another item, clamps the ratio, and returns the same object for an unchanged ratio", () => {
    const ws = openItem(EMPTY_WORKSPACE, session("a"));
    expect(splitTab(ws, "session:a", session("a"))).toBe(ws);
    const split = splitTab(ws, "session:a", { kind: "home" });
    expect(activeTab(split)?.split).toEqual({ item: { kind: "home" }, ratio: 0.5 });
    expect(activeTab(setSplitRatio(split, "session:a", 0.99))?.split?.ratio).toBe(0.85);
    expect(setSplitRatio(split, "session:a", 0.5)).toBe(split);
    expect(activeTab(unsplitTab(split, "session:a"))?.split).toBeNull();
  });

  it("keys items stably", () => {
    expect([itemKey({ kind: "home" }), itemKey(session("x")), itemKey({ kind: "settings", section: "language" }), itemKey({ kind: "dev-ui" })]).toEqual(["home", "session:x", "settings", "dev-ui"]);
  });
});
```

`item-path.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { itemFromPath, pathOfItem } from "./item-path.ts";

describe("item ↔ path", () => {
  it.each([
    ["/", { kind: "home" }],
    ["/s/abc", { kind: "session", id: "abc" }],
    ["/s/a%20b", { kind: "session", id: "a b" }],
    ["/settings", { kind: "settings", section: "appearance" }],
    ["/settings/", { kind: "settings", section: "appearance" }],
    ["/settings/shortcuts", { kind: "settings", section: "shortcuts" }],
  ])("%s", (path, item) => {
    expect(itemFromPath(path, false)).toEqual(item);
  });

  it.each(["/s/", "/s/a/b", `/s/${"x".repeat(129)}`, "/s/%E0%A4%A", "/settings/unknown", "/nope", "/dev/ui"])("%s is not found", (path) => {
    expect(itemFromPath(path, false)).toBeNull();
  });

  it("knows /dev/ui only where the gallery exists, and round-trips every item", () => {
    expect(itemFromPath("/dev/ui", true)).toEqual({ kind: "dev-ui" });
    for (const path of ["/", "/s/a%20b", "/settings/language", "/dev/ui"]) expect(pathOfItem(itemFromPath(path, true) as never)).toBe(path);
  });
});
```

`persist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMPTY_WORKSPACE, MAX_TABS } from "./model.ts";
import { parseWorkspace, serializeWorkspace } from "./persist.ts";

const tab = (id: string, extra = {}) => ({ key: `session:${id}`, item: { kind: "session", id }, split: null, ...extra });

describe("workspace persistence", () => {
  it("round-trips", () => {
    const ws = { tabs: [tab("a")], active: "session:a" };
    expect(parseWorkspace(serializeWorkspace(ws as never), false)).toEqual(ws);
  });

  it("drops a workspace of another version or shape", () => {
    for (const raw of [null, "{oops", '{"v":2,"tabs":[]}', '{"v":1,"tabs":"x"}', "[]"]) expect(parseWorkspace(raw, false)).toEqual(EMPTY_WORKSPACE);
  });

  it("drops unknown or invalid tabs, duplicate keys and the gallery outside dev, caps the count, repairs active", () => {
    const raw = JSON.stringify({
      v: 1,
      active: "session:gone",
      tabs: [tab("a"), tab("a"), { key: "x", item: { kind: "teapot" }, split: null }, { key: "dev-ui", item: { kind: "dev-ui" }, split: null }, tab("b", { split: { item: { kind: "home" }, ratio: 7 } }), ...Array.from({ length: 30 }, (_, i) => tab(`n${i}`))],
    });
    const ws = parseWorkspace(raw, false);
    expect(ws.tabs).toHaveLength(MAX_TABS);
    expect(ws.tabs.slice(0, 2).map((t) => t.key)).toEqual(["session:a", "session:b"]);
    expect(ws.tabs[1]?.split?.ratio).toBe(0.85);
    expect(ws.active).toBe("session:a");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/workspace`
Expected: FAIL.

- [ ] **Step 3: Implement**

`model.ts`:

```ts
export const SETTINGS_SECTIONS = ["appearance", "shortcuts", "language", "account"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type ItemRef =
  | { readonly kind: "home" }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "settings"; readonly section: SettingsSection }
  | { readonly kind: "dev-ui" };

export interface Split {
  readonly item: ItemRef;
  readonly ratio: number;
}
export interface Tab {
  readonly key: string;
  readonly item: ItemRef;
  readonly split: Split | null;
}
export interface Workspace {
  readonly tabs: readonly Tab[];
  readonly active: string | null;
}

export const EMPTY_WORKSPACE: Workspace = { tabs: [], active: null };
export const MAX_TABS = 24;
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

export function itemKey(item: ItemRef): string {
  switch (item.kind) {
    case "session":
      return `session:${item.id}`;
    case "home":
    case "settings":
    case "dev-ui":
      return item.kind;
  }
}

export const activeTab = (ws: Workspace): Tab | null => ws.tabs.find((tab) => tab.key === ws.active) ?? null;

export function openItem(ws: Workspace, item: ItemRef): Workspace {
  const key = itemKey(item);
  if (ws.tabs.some((tab) => tab.key === key)) {
    return { tabs: ws.tabs.map((tab) => (tab.key === key ? { ...tab, item } : tab)), active: key };
  }
  let tabs = [...ws.tabs, { key, item, split: null }];
  if (tabs.length > MAX_TABS) {
    const oldest = tabs.findIndex((tab) => tab.key !== ws.active && tab.key !== key);
    tabs = tabs.filter((_, index) => index !== oldest);
  }
  return { tabs, active: key };
}

export function closeTab(ws: Workspace, key: string): Workspace {
  const index = ws.tabs.findIndex((tab) => tab.key === key);
  if (index === -1) return ws;
  const tabs = ws.tabs.filter((tab) => tab.key !== key);
  if (ws.active !== key) return { tabs, active: ws.active };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, active: next?.key ?? null };
}

export function cycleTab(ws: Workspace, step: 1 | -1): Workspace {
  if (ws.tabs.length === 0) return ws;
  const index = Math.max(0, ws.tabs.findIndex((tab) => tab.key === ws.active));
  const next = ws.tabs[(index + step + ws.tabs.length) % ws.tabs.length] as Tab;
  return { ...ws, active: next.key };
}

const clamp = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number.isFinite(ratio) ? ratio : 0.5));
const updateTab = (ws: Workspace, key: string, change: (tab: Tab) => Tab): Workspace => {
  let changed = false;
  const tabs = ws.tabs.map((tab) => {
    if (tab.key !== key) return tab;
    const next = change(tab);
    changed ||= next !== tab;
    return next;
  });
  return changed ? { ...ws, tabs } : ws;
};

export const splitTab = (ws: Workspace, key: string, item: ItemRef): Workspace =>
  updateTab(ws, key, (tab) => (itemKey(item) === itemKey(tab.item) ? tab : { ...tab, split: { item, ratio: tab.split?.ratio ?? 0.5 } }));

export const unsplitTab = (ws: Workspace, key: string): Workspace => updateTab(ws, key, (tab) => (tab.split ? { ...tab, split: null } : tab));

export const setSplitRatio = (ws: Workspace, key: string, ratio: number): Workspace =>
  updateTab(ws, key, (tab) => (tab.split && tab.split.ratio !== clamp(ratio) ? { ...tab, split: { ...tab.split, ratio: clamp(ratio) } } : tab));
```

`item-path.ts`:

```ts
import { SETTINGS_SECTIONS, type ItemRef, type SettingsSection } from "./model.ts";

const MAX_ID = 128;

export function itemFromPath(pathname: string, devUi: boolean): ItemRef | null {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (path === "/") return { kind: "home" };
  if (path === "/settings") return { kind: "settings", section: "appearance" };
  if (path === "/dev/ui") return devUi ? { kind: "dev-ui" } : null;
  const settings = /^\/settings\/([a-z]+)$/.exec(path);
  if (settings) return SETTINGS_SECTIONS.includes(settings[1] as SettingsSection) ? { kind: "settings", section: settings[1] as SettingsSection } : null;
  const session = /^\/s\/([^/]+)$/.exec(path);
  if (!session) return null;
  let id: string;
  try {
    id = decodeURIComponent(session[1] ?? "");
  } catch {
    return null;
  }
  return id.length > 0 && id.length <= MAX_ID && !id.includes("/") ? { kind: "session", id } : null;
}

export function pathOfItem(item: ItemRef): string {
  switch (item.kind) {
    case "home":
      return "/";
    case "session":
      return `/s/${encodeURIComponent(item.id)}`;
    case "settings":
      return `/settings/${item.section}`;
    case "dev-ui":
      return "/dev/ui";
  }
}
```

(The round-trip test expects `/settings/language` for a settings item and `/` for home; `/settings` itself maps to the appearance section and comes back as `/settings/appearance`, which is not in the round-trip list.)

`persist.ts`: `parseWorkspace` reads `{ v: 1, tabs, active }`; each tab is kept only if its `item` passes a shape check (kind known; `session.id` string 1–128 without `/`; `settings.section` known; `dev-ui` only when `devUi`) and its `key` equals `itemKey(item)` (repairs nothing silently: a mismatched key drops the tab); duplicates by key are dropped after the first; a split is kept only with a valid item and a finite ratio, clamped; the list is cut to `MAX_TABS`; `active` falls back to the first tab's key (or null). Any parse error returns `EMPTY_WORKSPACE`. `serializeWorkspace` writes `{ v: 1, tabs, active }`.

`workspace-store.ts`: zustand; the initial value is `parseWorkspace(localStorage.getItem(WORKSPACE_KEY), import.meta.env.DEV)` inside a `try` (a throwing storage reads as empty); every action applies the matching model function and, when the result is a new object, writes `serializeWorkspace` (a refused write calls `reportClientIssue("storage_refused")`).

`workspace-store.test.ts` (`// @vitest-environment happy-dom`, `vi.mock("../../lib/report.ts")`): `open` of a session writes `pap.workspace.v1` with that tab; with `Storage.prototype.setItem` throwing, `open` still updates `ws` and `reportClientIssue` was called with `"storage_refused"`; `setRatio` with the same ratio writes nothing (spy on `setItem`: zero calls).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web/src/features/workspace`
Expected: PASS. Mutation check: remove the clamp in `setSplitRatio` → the 0.99 case fails; remove the eviction → the 25th-item case fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/features/workspace
git commit -m "feat(workspace): open items, split panes, persistence and URL mapping"
```

---

### Task 19a: Router and shell skeleton — routes, error screen, pane host, not found, connection banners

The auth gate stays in `RootLayout`; once signed in it renders `AppShell` instead of M1's `AccountBar` + `Outlet`. The URL is the single source of the active item: UI actions navigate, and the shell opens or activates the tab the path names (pw: URL state in `components/AppShell.tsx`). TanStack routes stay declared so M2's `Link to="/s/$sessionId"` and `navigate({ to: "/" })` keep type-checking; their components render nothing and the shell renders the panes. An unknown path shows a not-found screen and opens no tab (Review Focus 5) — M1 redirected it home.

This part builds the router, the shell frame and its panes; until Task 19b adds the rail and the top bar, the shell keeps M1's `AccountBar` above the panes, so sign-out keeps working and no file goes unused between the two commits.

**Files:**
- Modify: `apps/web/src/routes/router.tsx`, `apps/web/src/routes/RootLayout.tsx`, `apps/web/src/routes/RootLayout.test.tsx`
- Create: `apps/web/src/routes/RouteError.tsx`, `apps/web/src/routes/router.test.tsx`
- Create: `apps/web/src/routes/shell/AppShell.tsx`, `AppShell.test.tsx`, `PaneHost.tsx`, `pane-renderers.tsx`, `NotFound.tsx`, `ConnectionBanner.tsx`, `item-title.ts`, `item-title.test.ts`, `navigate.ts`, `use-shell-effects.ts`
- Create: `apps/web/src/testing/shell-bed.tsx`, `apps/web/src/features/workspace/index.ts`
- Modify: `apps/web/src/i18n/catalog/shell.ts`, `eslint.config.js` (`web-routes` may import `contracts`, M3-RT-14)

**Interfaces:**
- Consumes: `getRuntime`, `useConnectionState` (M1 runtime); `AccountBar` (M1, until Task 19b); `SessionListScreen`, `SessionScreen` (M2-owned, used as they exist on main); Tasks 4–11 primitives; Task 18 workspace.
- Produces:
  - `buildRouteTree(Root: () => ReactNode)` (the five routes under a root component), `createAppRouter(routeTree, history?)` (adds `defaultErrorComponent: RouteError`), `routeTree = buildRouteTree(RootLayout)` and `router = createAppRouter(routeTree)`; routes `/`, `/s/$sessionId`, `/settings`, `/settings/$section`, `/dev/ui`.
  - `RouteError()`: a translated "this screen stopped working" `EmptyState` with a Reload button, instead of TanStack's default untranslated screen (M3-RT-15).
  - `AppShell({ username: string | null; passkeysAvailable: boolean; onSignedOut(): void })`.
  - `PANE_RENDERERS: { [K in ItemRef["kind"]]: (item: Extract<ItemRef, { kind: K }>) => ReactNode }` with `home` → `<SessionListScreen />`, `session` → `<SessionScreen key={id} sessionId={id} />`, `settings` and `dev-ui` → `<NotFound />` until Tasks 24 and 28 replace them; `PaneHost({ tab: Tab | null })` renders `<section data-pane-kind={kind} aria-label={title}>` around the renderer.
  - `itemTitle(item: ItemRef, sessions: readonly SessionSummary[], t: Translate): string` in `item-title.ts` (session → basename of its cwd, else `shell.tab.session`; home → `shell.tab.home`; settings → `shell.tab.settings`; dev-ui → `gallery.title`); `navigateTo(navigate, item)` in `navigate.ts` (`pathOfItem`).
  - `useShellEffects(): void`: in this task only the URL → tab effect (Task 19b adds its `shell` parameter).
  - `features/workspace/index.ts` re-exports what the shell imports (`itemFromPath`, `pathOfItem`, `activeTab`, `useWorkspaceStore`, `EMPTY_WORKSPACE`, types `ItemRef`, `Tab`, `SettingsSection`, `SETTINGS_SECTIONS`); later tasks add names as they import them.
  - `renderShell(path: string, options?: { username?: string; onSignedOut?(): void; phone?: boolean }): Promise<Mounted & { router: AnyRouter }>` in `testing/shell-bed.tsx`: a memory-history router from `createAppRouter(buildRouteTree(() => <AppShell … />))` (no auth gate), inside `TooltipProvider` and `Toaster`; `phone` stubs `window.matchMedia` for the phone query.

**Rulings (pre-dispatch):**
- Routes may import `@pap/contracts` (types such as `SessionSummary` in `item-title.ts`, `sessions-cache.ts`, `session-groups.ts`, `palette-items.ts`): `eslint.config.js` adds `"contracts"` to `web-routes`' allow list (M3-RT-14). [M3R85]
- A render error anywhere under the router shows `RouteError` (translated, with Reload), never TanStack's default screen; whether the root route's own errors reach `defaultErrorComponent` in the pinned TanStack version is discovered during implementation (if not, `AppShell` wraps its body in a boundary that renders `RouteError`; `router.test.tsx` pins the outcome either way). [M3R86]
- M2 may restyle or rename `SessionListScreen`/`SessionScreen`; the shell imports them by these names and only `pane-renderers.tsx` adapts at the rebase. [M3R87]
- The shell does not use `<main>` until P3: M2's screens carry their own `<main>`. [M3R88]

- [ ] **Step 1: Write the failing tests**

`AppShell.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const auth = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("../../runtime/index.ts", async (original) => ({ ...(await original<typeof import("../../runtime/index.ts")>()), getRuntime: () => current.runtime }));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({ ...(await original<typeof import("../../features/auth/auth-api.ts")>()), logout: auth.logout }));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionScreen: ({ sessionId }: { sessionId: string }) => createElement("p", { "data-stub": "session" }, sessionId) };
});

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("idle");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  auth.logout.mockReset().mockResolvedValue(undefined);
});

describe("AppShell", () => {
  it("renders the home item in a pane and opens its tab", async () => {
    const page = await renderShell("/");
    expect(page.container.querySelector('[data-pane-kind="home"] [data-stub="home"]')).not.toBeNull();
    expect(useWorkspaceStore.getState().ws.active).toBe("home");
    await page.unmount();
  });

  it("opens a session from its URL", async () => {
    const page = await renderShell("/s/abc");
    expect(page.container.querySelector('[data-stub="session"]')?.textContent).toBe("abc");
    expect(useWorkspaceStore.getState().ws.tabs.map((tab) => tab.key)).toEqual(["session:abc"]);
    await page.unmount();
  });

  it("unknown path shows not found without opening a tab", async () => {
    const page = await renderShell("/nope");
    expect(page.container.querySelector("h2")?.textContent).toBe("This page does not exist");
    expect(useWorkspaceStore.getState().ws.tabs).toEqual([]);
    await click(button(page.container, "Go to the start"));
    await settle();
    expect(page.container.querySelector('[data-stub="home"]')).not.toBeNull();
    await page.unmount();
  });

  it("says it is reconnecting, and offers a reload when the page is out of date", async () => {
    const page = await renderShell("/");
    await act(async () => bed.fake.setState("waiting"));
    expect([...page.container.querySelectorAll('[role="status"]')].map((el) => el.textContent)).toContain("Reconnecting…");
    await act(async () => bed.fake.setState("outdated"));
    expect(hasButton(page.container, "Reload")).toBe(true);
    await page.unmount();
  });
});
```

(The not-found heading is the `EmptyState`'s `h2`. `settings.get` answers "no document" so later tasks' syncs never see the bed's default `{ ok: true }`.)

`router.test.tsx` (`// @vitest-environment happy-dom`): a root component that throws, routed by `createAppRouter(buildRouteTree(Thrower), createMemoryHistory({ initialEntries: ["/"] }))` inside `RouterProvider`, shows the `h2` "This screen stopped working" and a "Reload" button (silence `console.error` for the test, restore it after); a root that renders fine shows no such heading.

`item-title.test.ts`: a session titled by the basename of its cwd (`/home/ana/pi-agentic/` → `pi-agentic`), an unknown session id → "Session", home → "New session", settings → "Settings", dev-ui → "UI gallery" (with `t` = the English `translate`).

Update `RootLayout.test.tsx`: mock `./shell/AppShell.tsx` with a stub rendering `<p data-screen="shell">pap · {username}</p>`; the existing gate cases keep their assertions (`pap · ana` now comes from the stub), and the passkey case checks the stub's `passkeysAvailable` prop instead of AccountBar's markup.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/routes`
Expected: FAIL.

- [ ] **Step 3: Implement**

`router.tsx`:

```tsx
import { createRootRoute, createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { RootLayout } from "./RootLayout.tsx";
import { RouteError } from "./RouteError.tsx";

// The routes name the URLs (typed links, M2's Link to="/s/$sessionId"); AppShell renders the panes from the path.
const Empty = () => null;
const PATHS = ["/", "/s/$sessionId", "/settings", "/settings/$section", "/dev/ui"] as const;

/** The route tree under a root component: RootLayout in the app, AppShell alone in the shell test bed. */
export function buildRouteTree(Root: () => ReactNode) {
  const rootRoute = createRootRoute({ component: Root, notFoundComponent: Empty });
  return rootRoute.addChildren(PATHS.map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: Empty })));
}

/** The app's router options in one place, so the test bed gets the same translated error screen (M3-RT-15). */
export function createAppRouter<T extends ReturnType<typeof buildRouteTree>>(tree: T, history?: RouterHistory) {
  return createRouter({ routeTree: tree, history, defaultErrorComponent: RouteError });
}

export const routeTree = buildRouteTree(RootLayout);
export const router = createAppRouter(routeTree);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

(If `addChildren` loses the literal path types through `map`, declare the five routes one by one; the type check of M2's `Link` usages is the test. Verify `createRouter`'s `history` and `defaultErrorComponent` option names against the pinned `.d.ts`.)

`RouteError.tsx`: `EmptyState` with `t("shell.error.title")` / `t("shell.error.purpose")` and a primary `Button` `t("shell.reload")` → `window.location.reload()`, read through `useT()`.

`RootLayout.tsx`: unchanged gate; the `ready` branch returns `<AppShell username={state.username} passkeysAvailable={state.passkeysAvailable} onSignedOut={refresh} />`; the two connection lines move into `ConnectionBanner`.

`use-shell-effects.ts` (called by `AppShell`; Task 19b adds the socket and dispatcher effects):

```ts
import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";

export function useShellEffects(): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const open = useWorkspaceStore((state) => state.open);

  // The URL names the active item; the tab follows it.
  useEffect(() => {
    const item = itemFromPath(pathname, import.meta.env.DEV);
    if (item) open(item);
  }, [pathname, open]);
}
```

`AppShell.tsx` (desktop layout; Task 19b replaces `AccountBar` with the rail and the top bar, Task 23 adds the phone branch):

```tsx
<div data-shell="desktop" className="flex h-app flex-col">
  <AccountBar username={username} passkeysAvailable={passkeysAvailable} onSignedOut={onSignedOut} />
  <ConnectionBanner />
  {/* Not <main>: M2's screens carry their own <main> until P3 turns them into sections. */}
  <div id="pane-host" className="flex min-h-0 flex-1">{item ? <PaneHost tab={tab} /> : <NotFound />}</div>
</div>
```

where `item = itemFromPath(pathname, import.meta.env.DEV)`, `tab = activeTab(ws)` (pass `AccountBar` the props it has on main). `ConnectionBanner`: `waiting` → `<Banner tone="offline" title={t("connection.reconnecting")} />`; `outdated` → `<Banner tone="capacity" title={t("connection.outdated")} actions={<Button onClick={() => window.location.reload()}>{t("shell.reload")}</Button>} />`; nothing otherwise. `NotFound`: `EmptyState` with `shell.notFound.title` / `shell.notFound.purpose` and a primary `Button` (`shell.notFound.home`) navigating to `/`.

New `catalog/shell.ts` keys (en / fr): `shell.tab.home` "New session" / "Nouvelle session", `shell.tab.session` "Session" / "Session" (identical), `shell.tab.settings` "Settings" / "Réglages", `shell.reload` "Reload" / "Recharger", `shell.notFound.title` "This page does not exist" / "Cette page n'existe pas", `shell.notFound.purpose` "The link may be old, or the item was closed." / "Le lien est peut-être ancien, ou l'élément a été fermé.", `shell.notFound.home` "Go to the start" / "Aller au début", `shell.error.title` "This screen stopped working" / "Cet écran a cessé de fonctionner", `shell.error.purpose` "Reload the page to continue." / "Rechargez la page pour continuer.".

In `eslint.config.js`, change the `web-routes` rule to `{ from: "web-routes", allow: ["web-routes", "web-feature", "web-runtime", "web-i18n", "web-lib", "ui", "contracts"] }`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS, M2's session tests included (they render their screens directly, not through the shell).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web eslint.config.js
git commit -m "feat(shell): router with a translated error screen, pane host, not-found screen and connection banners"
```

---

### Task 19b: Rail, top bar, sessions cache, and the shell's socket and key effects

The rail and the top bar replace M1's account bar; each time the socket opens the shell reads the account settings (appearance and keybindings, compare-and-set documents of Tasks 15 and 17b) and the session list; one key dispatcher runs while the shell is mounted.

**Files:**
- Create: `apps/web/src/routes/shell/Rail.tsx`, `TopBar.tsx`, `sessions-cache.ts`, `sessions-cache.test.ts`
- Modify: `apps/web/src/routes/shell/AppShell.tsx`, `AppShell.test.tsx`, `use-shell-effects.ts`, `apps/web/src/features/appearance/index.ts` (+ `syncAccountAppearance`), `apps/web/src/features/commands/index.ts` (+ `installDispatcher`, `syncKeybindings`, `useKeybindingsStore`, `detectPlatform`, `registerCommand`, `runCommand`, `chordTokens`, `chordJoiner`, `keyNames`, `parseChord`), `apps/web/src/i18n/catalog/shell.ts`
- Delete: `apps/web/src/features/auth/AccountBar.tsx`, `AccountBar.test.tsx` (the account controls move to the rail menu here and to Settings in Task 24)

**Interfaces:**
- Consumes: `logout` (`features/auth/auth-api.ts`); Task 15 `syncAccountAppearance`, `startAppearance`; Task 17a `installDispatcher`, `registerCommand`, `runCommand`; Task 17b `syncKeybindings`, `startKeybindings`, `useKeybindingsStore`; Task 16a `detectPlatform`, `chordTokens`, `chordJoiner`, `keyNames`.
- Produces:
  - `useSessionsCache` state `{ sessions: readonly SessionSummary[]; status: "idle" | "loading" | "loaded" | "error"; refresh(rpc: Runtime["rpc"]): Promise<void> }` (sorted by `updatedAt` desc, capped at 500; a refresh while one runs returns the same promise, so two answers never race; `refresh` never rejects — a failure sets `status: "error"` and keeps the list).
  - `Rail({ username; onSignedOut })`, `TopBar({ title })`.
  - `useShellEffects(shell: { mobile: boolean; treeOpen(): boolean })` gains its parameter, the socket effect (appearance, keybindings and sessions on each `open`) and the dispatcher (`shell: () => ({ mobile: shell.mobile, treeOpen: shell.treeOpen() })`, so the dispatcher is installed once per `mobile` value and reads the drawer state at each key).

**Rulings (pre-dispatch):**
- Before M2's drafts exist, the reconnect banner says only "Reconnecting…"; P3 adds "your drafts stay on this device" once true (DESIGN §12). [M3R89]
- The project switcher of the top bar is deferred to M4 (no projects yet). [M3R90]
- The rail shows the logo, Settings and the account menu; agent avatars arrive in M11. [M3R91]
- The socket effect calls the three syncs fire-and-forget, each with a `.catch` that reports (they settle their own failures into a status; the catches only cover a future rejection). [M3R92]

- [ ] **Step 1: Write the failing tests**

Add to `AppShell.test.tsx`: `import { registerCommand, startKeybindings } from "../../features/commands/index.ts";`, `import { startAppearance } from "../../features/appearance/index.ts";`, `press` from the dom helpers; in `beforeEach` start both documents (`const started = [startAppearance(window), startKeybindings()]`) and stop them in an `afterEach`, so the syncs have something to read into; then these cases:

```tsx
  it("loads the account settings and the session list each time the socket opens", async () => {
    const page = await renderShell("/");
    await act(async () => bed.fake.setState("open"));
    await settle();
    expect(bed.called("settings.get").map((call) => call.params)).toEqual([{ key: "appearance" }, { key: "keybindings" }]);
    expect(bed.called("sessions.list")).toHaveLength(1);
    await page.unmount();
  });

  it("titles the top bar with the active item: a session by its folder", async () => {
    bed.handlers["sessions.list"] = () => ({ sessions: [{ id: "abc", cwd: "/home/ana/pi-agentic", status: "idle", createdAt: 1, updatedAt: 2 }] });
    const page = await renderShell("/s/abc");
    await act(async () => bed.fake.setState("open"));
    await settle();
    expect(page.container.querySelector("header")?.textContent).toContain("pi-agentic");
    await page.unmount();
  });

  it("the rail opens Settings, and its account menu signs out", async () => {
    const onSignedOut = vi.fn();
    const page = await renderShell("/", { onSignedOut });
    await click(page.container.querySelector('[aria-label="Settings"]') as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/settings/appearance");
    // Radix menus open from the keyboard in happy-dom (they listen for pointerdown, not click).
    await press(page.container.querySelector('[aria-label="Account"]') as HTMLElement, { key: "Enter" });
    await settle();
    await press(document.activeElement as HTMLElement, { key: "Enter" });
    await settle();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("listens for shortcuts only while mounted", async () => {
    const tree = vi.fn();
    const off = registerCommand("drawer.tree.toggle", tree);
    const page = await renderShell("/");
    await press(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    expect(tree).toHaveBeenCalledOnce();
    await page.unmount();
    await press(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    expect(tree).toHaveBeenCalledOnce();
    off();
  });
```

(The keyboard path through the account menu relies on Radix moving focus to the first enabled item, "Sign out", after the disabled username row; if the pinned Radix version focuses the content instead, press `ArrowDown` once before `Enter`.)

`sessions-cache.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionsCache } from "./sessions-cache.ts";

const s = (id: string, updatedAt: number) => ({ id, cwd: `/w/${id}`, status: "idle", createdAt: 0, updatedAt }) as const;
beforeEach(() => useSessionsCache.setState({ sessions: [], status: "idle" }));

describe("sessions cache", () => {
  it("sorts newest first and keeps at most 500", async () => {
    const call = vi.fn().mockResolvedValue({ sessions: Array.from({ length: 600 }, (_, i) => s(String(i), i)) });
    await useSessionsCache.getState().refresh({ call } as never);
    const state = useSessionsCache.getState();
    expect([state.sessions.length, state.sessions[0]?.id, state.status]).toEqual([500, "599", "loaded"]);
  });

  it("shares one call between concurrent refreshes, and keeps the list when a refresh fails", async () => {
    const call = vi.fn().mockResolvedValue({ sessions: [s("a", 1)] });
    await Promise.all([useSessionsCache.getState().refresh({ call } as never), useSessionsCache.getState().refresh({ call } as never)]);
    expect(call).toHaveBeenCalledOnce();
    await expect(useSessionsCache.getState().refresh({ call: vi.fn().mockRejectedValue(new Error("x")) } as never)).resolves.toBeUndefined();
    expect([useSessionsCache.getState().status, useSessionsCache.getState().sessions.length]).toEqual(["error", 1]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/routes`
Expected: FAIL.

- [ ] **Step 3: Implement**

`use-shell-effects.ts` takes `shell: { readonly mobile: boolean; treeOpen(): boolean }` and gains:

```ts
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);

  // Account settings and the session list, each time the socket opens. The three map their own failures to a
  // status the screens show; the catches only report a rejection a future change might introduce.
  useEffect(() => {
    if (connection !== "open") return;
    void syncAccountAppearance(runtime.rpc).catch(() => reportClientIssue("setting_load_failed"));
    void syncKeybindings(runtime.rpc).catch(() => reportClientIssue("setting_load_failed"));
    void useSessionsCache.getState().refresh(runtime.rpc).catch(() => reportClientIssue("sessions_list_failed"));
  }, [connection, runtime]);

  // One key dispatcher while the shell is mounted; it reads the drawer state at each key.
  const { mobile, treeOpen } = shell;
  useEffect(
    () =>
      installDispatcher({
        win: window,
        platform: detectPlatform(),
        rules: () => useKeybindingsStore.getState().rules,
        shell: () => ({ mobile, treeOpen: treeOpen() }),
      }),
    [mobile, treeOpen],
  );
```

(with the imports of `syncAccountAppearance`, `detectPlatform`, `installDispatcher`, `syncKeybindings`, `useKeybindingsStore`, `reportClientIssue`, `getRuntime`, `useConnectionState`, `useSessionsCache`; `AppShell` passes `treeOpen` as a stable callback — `() => false` until Task 21 reads its drawer state through a ref).

`AppShell.tsx` (desktop layout):

```tsx
<div data-shell="desktop" className="flex h-app rail-right:flex-row-reverse">
  <Rail username={username} onSignedOut={onSignedOut} />
  <div className="flex min-w-0 flex-1 flex-col">
    <TopBar title={title} />
    <ConnectionBanner />
    {/* Not <main>: M2's screens carry their own <main> until P3 turns them into sections. */}
    <div id="pane-host" className="flex min-h-0 flex-1">{item ? <PaneHost tab={tab} /> : <NotFound />}</div>
  </div>
</div>
```

where `title = item ? itemTitle(item, sessions, t) : t("shell.notFound.title")` with `sessions` from `useSessionsCache`. `Rail`: `<nav aria-label={t("shell.rail.label")} data-slot="rail" className="flex w-rail shrink-0 flex-col items-center gap-s2 border-r border-border bg-bg-side py-s2 rail-right:border-l rail-right:border-r-0">` with the `Mark` (link to `/`, label `app.name`), a flexible spacer, `IconButton icon={IconSettings} label={t("shell.rail.settings")} shortcut={…}` navigating to `/settings/appearance`, and a `Menu` whose trigger is `IconButton icon={IconAccount} label={t("shell.rail.account")}` with items `username` (disabled, informational) and `t("shell.rail.signOut")` → `logout().then(onSignedOut, () => toast({ message: t("shell.signOutFailed"), tone: "error" }))`. `TopBar`: `<header className="flex h-bar shrink-0 items-center gap-s2 border-b border-border bg-bg-side px-s2">` with the tree `IconButton` (label `shell.top.tree`, shortcut tokens of `drawer.tree.toggle`), the title (`truncate text-ui font-semibold`), a spacer, the Inbox `IconButton` (label `shell.top.inbox`) and the palette button (`Button variant="ghost" size="sm"` showing `Kbd` of `palette.toggle`, label `shell.top.palette`) — the drawer and palette buttons call `runCommand("drawer.tree.toggle")`, `runCommand("drawer.inbox.toggle")`, `runCommand("palette.toggle")` (handlers arrive in Tasks 21–22; until then the buttons do nothing visible, which is the expected intermediate state).


New `catalog/shell.ts` keys (en / fr): `shell.rail.label` "Agents" / "Agents" (add to `IDENTICAL_IN_FR`), `shell.rail.settings` "Settings" / "Réglages", `shell.rail.account` "Account" / "Compte", `shell.rail.signOut` "Sign out" / "Se déconnecter", `shell.signOutFailed` "Sign-out did not reach pap. Try again." / "La déconnexion n'a pas atteint pap. Réessayez.", `shell.top.tree` "Sessions" / "Sessions" (identical), `shell.top.inbox` "Inbox" / "Boîte de réception", `shell.top.palette` "Search and commands" / "Recherche et commandes".

`sessions-cache.ts`: zustand; `refresh` keeps one in-flight promise (`inFlight ??= rpc.call("sessions.list", {}).then(…).catch(…).finally(() => (inFlight = null))`), sorts by `updatedAt` desc, keeps the first 500, sets `status`; a failure sets `status: "error"`, keeps the list and reports `sessions_list_failed`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(shell): rail, top bar, sessions cache, and settings sync and shortcuts while the shell is mounted"
```

---

### Task 20: Tab bar and split panes

**Files:**
- Create: `apps/web/src/routes/shell/TabBar.tsx`, `TabBar.test.tsx`
- Create: `apps/web/src/features/workspace/separator.ts`, `separator.test.ts`, `SplitView.tsx`, `SplitView.test.tsx`, `use-element-width.ts`
- Modify: `apps/web/src/routes/shell/PaneHost.tsx`, `AppShell.tsx`, `catalog/shell.ts`

**Interfaces:**
- Consumes: Task 18 (`useWorkspaceStore`, `splitTab`, `pathOfItem`), Tasks 19a/19b (`itemTitle`, `useSessionsCache`), `OpenTab`, `IconButton`, `Menu` (Tasks 5, 7, 8).
- Produces:
  - `ratioBounds(widthPx: number, minPx: number): readonly [number, number]` (`[max(0.15, min/width), min(0.85, 1 - min/width)]`, `[0.5, 0.5]` below two minimums), `clampRatio(ratio, widthPx, minPx)`, `ratioAfterKey(ratio, key: string, shift: boolean, widthPx, minPx): number | null` (ArrowLeft/ArrowRight move 8 px, 40 px with Shift; Home resets to 0.5; anything else null — Orca `CsvColumnResizeHandle.tsx`), `ratioFromPointer(clientX, left, widthPx, minPx)`.
  - `useElementWidth(ref): number` (ResizeObserver; 0 before the first measure).
  - `SplitView({ ratio: number; onRatio(ratio: number): void; first: ReactNode; second: ReactNode; label: string; minPx?: number })` — below `2 × minPx` it renders `first` only.
  - `TabBar()` (reads the workspace and the sessions cache, navigates on select/close/new).

**Rulings (pre-dispatch):**
- Below 640 px of pane area the split shows the first pane only (the 320 px minimum cannot hold both). [M3R93]
- Tab middle-click and drag-to-reorder are not in M3; a focused tab closes with Delete (Task 7) or `tab.close`. [M3R94]
- `features/workspace/index.ts` gains only the names this task's route files import (M3-RT-13). [M3R95]

- [ ] **Step 1: Write the failing tests**

`separator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clampRatio, ratioAfterKey, ratioBounds, ratioFromPointer } from "./separator.ts";

describe("pane separator (DESIGN.md §8: 320 px minimum)", () => {
  it("bounds the ratio by the pixel minimum and the 15/85 % limits", () => {
    expect(ratioBounds(1000, 320)).toEqual([0.32, 0.68]);
    expect(ratioBounds(4000, 320)).toEqual([0.15, 0.85]);
    expect(ratioBounds(600, 320)).toEqual([0.5, 0.5]);
    expect(clampRatio(0.1, 1000, 320)).toBe(0.32);
  });
  it("moves 8 px per arrow, 40 px with Shift, resets with Home", () => {
    expect(ratioAfterKey(0.5, "ArrowLeft", false, 1000, 320)).toBeCloseTo(0.492, 6);
    expect(ratioAfterKey(0.5, "ArrowRight", true, 1000, 320)).toBeCloseTo(0.54, 6);
    expect(ratioAfterKey(0.33, "ArrowLeft", true, 1000, 320)).toBe(0.32);
    expect(ratioAfterKey(0.6, "Home", false, 1000, 320)).toBe(0.5);
    expect(ratioAfterKey(0.6, "Enter", false, 1000, 320)).toBeNull();
  });
  it("turns a pointer position into a clamped ratio", () => {
    expect(ratioFromPointer(600, 100, 1000, 320)).toBe(0.5);
    expect(ratioFromPointer(150, 100, 1000, 320)).toBe(0.32);
  });
});
```

`SplitView.test.tsx` (mock `./use-element-width.ts` to return 1000): the separator has `role="separator"`, `aria-orientation="vertical"`, `aria-valuemin="32"`, `aria-valuemax="68"`, `aria-valuenow="50"`, its label, and `tabIndex=0`; pressing ArrowLeft on it calls `onRatio` with `0.492`; with the mocked width at 600, only `first` is rendered and no separator exists.

`TabBar.test.tsx` (shell bed at `/s/a` with tabs `session:a`, `home` in the store): a `role="tablist"` labelled `Open items` holds two tabs, `session:a` selected; clicking the home tab navigates to `/`; clicking `Close a` (the close label) on the active tab navigates to `/` (the neighbour) and removes the tab; ArrowRight on the selected tab moves focus to the next tab; the `New tab` button navigates to `/`; the split button (`Split pane`) adds a split with the most recent other open item (home) and its label becomes `Close split`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/workspace apps/web/src/routes/shell`
Expected: FAIL.

- [ ] **Step 3: Implement**

`separator.ts`:

```ts
import { MAX_RATIO, MIN_RATIO } from "./model.ts";

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function ratioBounds(widthPx: number, minPx: number): readonly [number, number] {
  if (widthPx < minPx * 2) return [0.5, 0.5];
  return [round(Math.max(MIN_RATIO, minPx / widthPx)), round(Math.min(MAX_RATIO, 1 - minPx / widthPx))];
}

export function clampRatio(ratio: number, widthPx: number, minPx: number): number {
  const [low, high] = ratioBounds(widthPx, minPx);
  return round(Math.min(high, Math.max(low, ratio)));
}

/** Orca CsvColumnResizeHandle: arrows step 8 px (40 with Shift), Home resets. */
export function ratioAfterKey(ratio: number, key: string, shift: boolean, widthPx: number, minPx: number): number | null {
  if (key === "Home") return 0.5;
  const step = (shift ? 40 : 8) / Math.max(widthPx, 1);
  if (key === "ArrowLeft") return clampRatio(ratio - step, widthPx, minPx);
  if (key === "ArrowRight") return clampRatio(ratio + step, widthPx, minPx);
  return null;
}

export const ratioFromPointer = (clientX: number, left: number, widthPx: number, minPx: number): number => clampRatio((clientX - left) / Math.max(widthPx, 1), widthPx, minPx);
```

`SplitView.tsx`: a flex row; the first pane's `style={{ flexBasis: `${ratio * 100}%` }}` with `min-w-pane min-h-0 flex flex-col`, the second `flex-1 min-w-pane`; between them a 6 px separator (`w-1.5 shrink-0 cursor-col-resize bg-transparent focus-ring` with a 1 px `bg-border` line, hover and focus `bg-agent`) carrying the ARIA attributes above. Keyboard: `onKeyDown` → `ratioAfterKey` → `onRatio` (and `preventDefault` when non-null). Pointer (Orca `TabGroupSplitNodeTree.tsx`): `onPointerDown` takes pointer capture and ignores a second pointer; `onPointerMove` writes the first pane's `style.flexBasis` directly through a ref (no store update per move); `pointerup`, `pointercancel` and `lostpointercapture` commit once with `onRatio(ratioFromPointer(...))` and release. Width comes from `useElementWidth(containerRef)` (a `ResizeObserver` disconnected on unmount).

`TabBar.tsx`: `role="tablist"` (`aria-label={t("shell.tabs.label")}`), one `OpenTab` per tab (`tabId` = `tab-${key}`, `panelId` = `pane-main`, `title` = `itemTitle`, status `running` for a session whose summary status is `running`, `closeLabel` = `t("shell.tabs.close", { title })`); roving focus with ArrowLeft/ArrowRight/Home/End on the tab buttons; then `IconButton icon={IconPlus} label={t("shell.tabs.new")}` → `/` (labelled "New tab", not "New session", so it never shares a name with M2's create button); then the split toggle (`IconSplit`, label `shell.tabs.split` / `shell.tabs.unsplit`). Select → `navigate(pathOfItem(tab.item))`; close → `close(key)` then navigate to the new active tab's path, or `/` when none. Split → `split(activeKey, mostRecentOtherItem ?? { kind: "home" })` where the most recent other item is the tab before the active one in the list.

`PaneHost.tsx`: with a split, `SplitView` with `first` = the tab's pane and `second` = a pane headed by a row (`h-bar border-b border-border`) holding its title, a `Menu` "Show in this pane" (`shell.pane.choose`) listing the other open items (choosing one calls `split(key, item)`), and `IconButton icon={IconClose} label={t("shell.tabs.unsplit")}`; `onRatio` → `setRatio(key, ratio)`. The main pane keeps `id="pane-main"` and `role="tabpanel"` with `aria-labelledby` the active tab's id.

New keys: `shell.tabs.label` "Open items" / "Éléments ouverts", `shell.tabs.close` "Close {title}" / "Fermer {title}", `shell.tabs.new` "New tab" / "Nouvel onglet", `shell.tabs.split` "Split pane" / "Diviser le panneau", `shell.tabs.unsplit` "Close split" / "Fermer la division", `shell.pane.choose` "Show in this pane" / "Afficher dans ce panneau", `shell.pane.separator` "Resize panes" / "Redimensionner les panneaux", `shell.pane.terminal` "Terminal" / "Terminal" (identical, used by the phone switch later).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(shell): open-item tabs and keyboard-resizable split panes"
```

---

### Task 21: Drawers and shell commands — ⌘B tree, Inbox, the shell's command handlers

DESIGN.md §8: left drawer = the ⌘B tree (project → lane → session), 300 px; right drawer = the Inbox, 360 px. Projects (M4) and lanes (M9) do not exist yet, so the tree groups sessions by working directory, the level M4 replaces with project groups. The Inbox ships its empty state (its stream is M10/M11). The shell registers the handlers of the commands it owns (Orca `app-command-handlers.ts`).

**Files:**
- Create: `apps/web/src/routes/shell/TreeDrawer.tsx`, `SessionTree.tsx`, `session-groups.ts`, `session-groups.test.ts`, `InboxDrawer.tsx`, `shell-commands.ts`, `shell-commands.test.tsx`, `drawers.test.tsx`
- Create: `apps/web/src/lib/lazy.tsx`, `apps/web/src/lib/lazy.test.tsx` (the boundary every lazy chunk mounts through, M3-RT-15)
- Modify: `apps/web/src/routes/shell/AppShell.tsx` (drawer and help state, the tree state for the dispatcher, the lazy shortcuts help), `catalog/shell.ts`, `apps/web/src/features/appearance/index.ts` (+ `useAppearanceStore`), `apps/web/src/features/commands/index.ts` (+ `useCommand`, `ShortcutsHelp` stays reached by dynamic import only), `eslint.config.js` (`web-lib` may import `ui`)

**Interfaces:**
- Consumes: Tasks 8, 16b, 17a, 17b, 18, 19a, 19b.
- Produces:
  - `interface SessionGroup { cwd: string; label: string; sessions: readonly SessionSummary[] }`; `groupSessions(sessions, filter: string, cap?: number): { groups: SessionGroup[]; hidden: number }` (groups by `cwd`, groups and rows by latest `updatedAt` first, filter = NFKD, case-insensitive substring of the cwd, at most `cap` = 200 rows, `hidden` = rows left out).
  - `SessionTree({ onPick(id: string): void })` (shared by the drawer and the phone "Lists" tab).
  - `TreeDrawer({ open; onOpenChange })`, `InboxDrawer({ open; onOpenChange })`.
  - `useShellCommands(state: { setTreeOpen(open: boolean | ((o: boolean) => boolean)): void; setInboxOpen(...); setHelpOpen(...); mobile: boolean; onSignedOut(): void })` registering `drawer.tree.toggle`, `drawer.inbox.toggle`, `settings.open`, `shortcuts.help`, `session.new`, `tab.next`, `tab.prev`, `tab.close`, `pane.split`, `pane.close`, `appearance.cycleMode` (system → night → day → system), `auth.signOut`.
  - `lib/lazy.tsx`: `LazyBoundary({ resetKey: number; onError(): void; children })` (class component: a chunk that fails to load, or a lazy panel that throws, renders nothing and calls `onError` once; a new `resetKey` re-arms it; children render inside `Suspense` with no fallback), `useRetryableLazy<P>(load): { Lazy; attempt: number; retry(): void }` (a fresh `lazy()` per attempt: React keeps a rejected import inside the lazy component), `notifyLazyFailure(text: { message: string; reload: string }): void` (reports `lazy_chunk_failed` and shows an error toast with a Reload action).

**Rulings (pre-dispatch):**
- The tree groups sessions by working directory until M4's projects. [M3R96]
- The Inbox empty state states its purpose without promising a date. [M3R97]
- More than 200 sessions: the tree shows 200 and says how many more, pointing to ⌘K (search proper is M4's FTS5). [M3R98]
- Every lazy chunk (shortcuts help here; palette, Settings and theme editor later) mounts through `LazyBoundary` + `useRetryableLazy`: a stale chunk after a pap update leaves the shell standing, closes the panel, says "This part of pap did not load. pap may have been updated: reload the page." with a Reload action, and the next open tries again (M3-RT-15, owner R3-5). It lives in `lib/` so features can use it; `web-lib` may import `@pap/ui` for the toast. [M3R99]
- The tree drawer state reaches the dispatcher through a ref read at each key (`treeOpen`, M3-RT-30), so `mod+b` closes the drawer it opened. [M3R72]

- [ ] **Step 1: Write the failing tests**

`session-groups.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupSessions } from "./session-groups.ts";

const s = (id: string, cwd: string, updatedAt: number) => ({ id, cwd, status: "idle", createdAt: 0, updatedAt }) as const;

describe("session groups (the tree until M4's projects)", () => {
  it("groups by working directory, newest group and newest row first", () => {
    const { groups } = groupSessions([s("a", "/w/api", 1), s("b", "/w/web", 5), s("c", "/w/api", 9)], "");
    expect(groups.map((g) => [g.label, g.sessions.map((x) => x.id)])).toEqual([["api", ["c", "a"]], ["web", ["b"]]]);
  });
  it("filters on the folder, accents and case aside", () => {
    expect(groupSessions([s("a", "/w/Café", 1), s("b", "/w/web", 2)], "cafe").groups.map((g) => g.label)).toEqual(["Café"]);
  });
  it("shows at most 200 rows and counts the rest", () => {
    const many = Array.from({ length: 250 }, (_, i) => s(String(i), `/w/p${i % 3}`, i));
    const { groups, hidden } = groupSessions(many, "");
    expect(groups.reduce((n, g) => n + g.sessions.length, 0)).toBe(200);
    expect(hidden).toBe(50);
  });
});
```

`drawers.test.tsx` (shell bed, `sessions.list` answering two sessions in `/w/api`): `Ctrl+B` opens a dialog titled `Sessions` listing a group `api` with two rows; clicking a row navigates to `/s/<id>` and closes the drawer; typing `zzz` in the filter shows `No session matches.`; the Inbox button opens a dialog titled `Inbox` containing the empty state `Nothing waits for you`.

`shell-commands.test.tsx` (shell bed with tabs `session:a`, `session:b`, active `b`): `runCommand("tab.next")` navigates to `/s/a`; `runCommand("tab.close")` closes the active tab and navigates to the neighbour; `runCommand("pane.split")` adds a split on desktop and returns false (declines) when `mobile`; `runCommand("appearance.cycleMode")` moves `useAppearanceStore` mode `system → night → day → system`; `runCommand("settings.open")` navigates to `/settings/appearance`; `runCommand("auth.signOut")` calls `logout` then `onSignedOut`; `runCommand("shortcuts.help")` shows, once its chunk has loaded (`vi.waitFor`, 2 s), a dialog titled `Keyboard shortcuts`; with the tree drawer open, `Ctrl+B` closes it (M3-RT-30).

`apps/web/src/lib/lazy.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, click, mount } from "../testing/dom.ts";
import { LazyBoundary, useRetryableLazy } from "./lazy.tsx";

function Host({ load, onError }: { load: () => Promise<{ default: ComponentType }>; onError(): void }) {
  const { Lazy, attempt, retry } = useRetryableLazy(load);
  return (
    <>
      <button type="button" onClick={retry}>
        retry
      </button>
      <LazyBoundary resetKey={attempt} onError={onError}>
        <Lazy />
      </LazyBoundary>
    </>
  );
}

describe("lazy chunks (M3-RT-15)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a chunk that fails to load renders nothing, reports once, and the next attempt loads again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React logs the caught error
    const Panel = () => <p>panel</p>;
    const load = vi.fn<() => Promise<{ default: ComponentType }>>().mockRejectedValueOnce(new Error("chunk gone")).mockResolvedValue({ default: Panel });
    const onError = vi.fn();
    const page = await mount(<Host load={load} onError={onError} />);
    await act(async () => {
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce(), { timeout: 2_000 });
    });
    expect(page.container.textContent).toBe("retry");
    await click(button(page.container, "retry"));
    await act(async () => {
      await vi.waitFor(() => expect(page.container.textContent).toContain("panel"), { timeout: 2_000 });
    });
    expect([load.mock.calls.length, onError.mock.calls.length]).toEqual([2, 1]);
    await page.unmount();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/routes/shell`
Expected: FAIL.

- [ ] **Step 3: Implement**

`session-groups.ts`:

```ts
import type { SessionSummary } from "@pap/contracts";

export interface SessionGroup {
  readonly cwd: string;
  readonly label: string;
  readonly sessions: readonly SessionSummary[];
}

const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const basename = (cwd: string) => cwd.replace(/\/+$/, "").split("/").at(-1) || cwd;

export function groupSessions(sessions: readonly SessionSummary[], filter: string, cap = 200): { groups: SessionGroup[]; hidden: number } {
  const needle = normalize(filter.trim());
  const byCwd = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (needle && !normalize(session.cwd).includes(needle)) continue;
    const list = byCwd.get(session.cwd) ?? [];
    list.push(session);
    byCwd.set(session.cwd, list);
  }
  const sorted = [...byCwd.entries()]
    .map(([cwd, list]) => ({ cwd, label: basename(cwd), sessions: [...list].sort((a, b) => b.updatedAt - a.updatedAt) }))
    .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
  let left = cap;
  let hidden = 0;
  const groups: SessionGroup[] = [];
  for (const group of sorted) {
    const shown = group.sessions.slice(0, Math.max(0, left));
    hidden += group.sessions.length - shown.length;
    left -= shown.length;
    if (shown.length > 0) groups.push({ ...group, sessions: shown });
  }
  return { groups, hidden };
}
```

`SessionTree`: a filter `TextField` (`shell.tree.filter`), then per group a heading (`label-hud text-muted` label, the full cwd in `font-mono text-code text-dim` underneath), then rows as `<a href>` links (`TanStack Link to="/s/$sessionId"`) with a `RunStatusChip` when running, `pointer-coarse:min-h-11`; `hidden > 0` → `t("shell.tree.more", { count })` ("{count} more. Use ⌘K to find older sessions." / "{count} de plus. Utilisez ⌘K pour retrouver les plus anciennes." — the chord shown is the effective palette chord via `chordTokens`, interpolated as text); no match → `shell.tree.empty`; while `useSessionsCache` loads for the first time, the feedback rule applies (nothing under 100 ms, then a `Spinner` labelled `shell.tree.loading`); an error shows `Banner tone="capacity"` with `shell.tree.error` and a Retry button. The drawer refreshes the cache when it opens.

`InboxDrawer`: `Dialog variant="drawer-right"` titled `shell.inbox.title` with `EmptyState` (`shell.inbox.emptyTitle` "Nothing waits for you" / "Rien ne vous attend", `shell.inbox.emptyPurpose` "Approvals, replies and finished tasks of your agents appear here, those that need you first." / "Les approbations, réponses et tâches terminées de vos agents apparaissent ici, celles qui vous attendent d'abord.").

`shell-commands.ts`: one `useCommand` per id; handlers navigate with `pathOfItem`, mutate the workspace store, toggle drawer state, or call `runCommand`-free code; `pane.split` returns `false` when `mobile`; `tab.*` return `false` when there are no tabs (so the key keeps its browser meaning); `auth.signOut` uses the same `logout().then(onSignedOut, toast error)` as the rail.

`apps/web/src/lib/lazy.tsx`:

```tsx
import { toast } from "@pap/ui";
import { Component, lazy, Suspense, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { reportClientIssue } from "./report.ts";

interface BoundaryProps {
  readonly resetKey: number;
  onError(): void;
  readonly children: ReactNode;
}

/**
 * Around every lazy chunk (M3-RT-15): a chunk that fails to load (an open tab after a pap update, whose old file
 * name is gone) or a lazy panel that throws renders nothing and calls `onError` once; a new `resetKey` re-arms it.
 * The shell stays standing instead of TanStack's root error screen.
 */
export class LazyBoundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onError();
  }

  componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render(): ReactNode {
    return this.state.failed ? null : <Suspense fallback={null}>{this.props.children}</Suspense>;
  }
}

/** A lazy component that can try again: React keeps a rejected import inside a lazy component for good. */
export function useRetryableLazy<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): {
  Lazy: LazyExoticComponent<ComponentType<P>>;
  attempt: number;
  retry(): void;
} {
  const [Lazy, setLazy] = useState(() => lazy(load));
  const [attempt, setAttempt] = useState(0);
  return {
    Lazy,
    attempt,
    retry: () => {
      setLazy(() => lazy(load));
      setAttempt((value) => value + 1);
    },
  };
}

/** One line in the client log and a toast with Reload; the strings come translated from the caller. */
export function notifyLazyFailure(text: { readonly message: string; readonly reload: string }): void {
  reportClientIssue("lazy_chunk_failed");
  toast({ message: text.message, tone: "error", action: { label: text.reload, altText: text.reload, run: () => window.location.reload() } });
}
```

In `eslint.config.js`, the `web-lib` rule becomes `{ from: "web-lib", allow: ["web-lib", "web-runtime", "contracts", "ui"] }`.

`AppShell.tsx` holds `treeOpen`, `inboxOpen` and `helpOpen` state; a ref mirrors `treeOpen` (written in an effect) and `useShellEffects({ mobile, treeOpen: readTreeOpen })` gets a stable `readTreeOpen = useCallback(() => treeRef.current, [])`. The shortcuts help is lazy (owner R3-5):

```tsx
const loadShortcutsHelp = () => import("../../features/commands/ShortcutsHelp.tsx");
// inside AppShell:
const help = useRetryableLazy(loadShortcutsHelp);
{helpOpen ? (
  <LazyBoundary
    resetKey={help.attempt}
    onError={() => {
      setHelpOpen(false);
      help.retry();
      notifyLazyFailure({ message: t("shell.lazyFailed"), reload: t("shell.reload") });
    }}
  >
    <help.Lazy open onOpenChange={setHelpOpen} platform={platform} />
  </LazyBoundary>
) : null}
```

New key: `shell.lazyFailed` "This part of pap did not load. pap may have been updated: reload the page." / "Cette partie de pap ne s'est pas chargée. pap a peut-être été mis à jour : rechargez la page."

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm knip && pnpm test:int apps/web/src/build-output.int.test.ts`
Expected: PASS (the shortcuts help is now a lazy chunk). Mutation checks: reuse one `lazy()` for every attempt → the "next attempt loads again" case fails; drop `getDerivedStateFromError` → the failing load escapes the boundary and the test errors.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web eslint.config.js
git commit -m "feat(shell): session tree and inbox drawers, the shell's command handlers, and lazy chunks that survive an update"
```

---

### Task 22: Cmd+K command palette

Spec C §7.2 picks cmdk; Orca uses it with its filter off and ranks results itself (`components/WorktreeJumpPalette.tsx`, `cmd-j/palette-results.ts`). Ranking follows T3 (`CommandPalette.logic.ts` 194-322): NFKD, diacritics stripped, every query token a substring of the item's search terms, earlier terms score higher, exact/prefix/substring bonus on the title, ties by recency then order; a leading `>` keeps actions only. Digit chords are not bound inside the palette: Ctrl/⌘+1..9 and (off Apple platforms) Alt+1..9 are the browser's tab keys and never reach the page (M3-RT-31). Each group renders at most 50 rows (Orca's section render cap) and the result count is announced politely (Orca's `aria-live` count). The palette module (with cmdk) loads on first open, so it stays out of the initial bundle (spec C §7.4).

**Files:**
- Create: `apps/web/src/features/commands/palette/rank.ts`, `rank.test.ts`, `CommandPalette.tsx`, `CommandPalette.test.tsx`
- Create: `apps/web/src/routes/shell/palette-items.ts`, `palette-items.test.ts`, `PaletteHost.tsx`, `PaletteHost.test.tsx`
- Modify: `apps/web/package.json` (`cmdk`), `apps/web/src/routes/shell/AppShell.tsx`, `catalog/commands.ts`, `apps/web/src/features/commands/index.ts` (+ the names `palette-items.ts` and `PaletteHost.tsx` import)

**Interfaces:**
- Consumes: Tasks 16a–21 (`LazyBoundary`, `useRetryableLazy`, `notifyLazyFailure` from Task 21).
- Produces:
  - `type PaletteGroup = "open" | "actions" | "sessions" | "settings"`; `interface PaletteItem { id: string; group: PaletteGroup; title: string; detail?: string; searchTerms: readonly string[]; chord?: readonly string[]; chordJoiner?: "" | "+"; recency?: number; run(): void }`.
  - `normalizeSearch(text: string): string`; `rankItems(items: readonly PaletteItem[], query: string, cap?: number): { groups: Array<{ group: PaletteGroup; items: PaletteItem[] }>; count: number; actionsOnly: boolean }`.
  - `CommandPalette({ open: boolean; onOpenChange(open: boolean): void; items: readonly PaletteItem[]; platform: Platform })` (default export too, for `lazy`).
  - `buildPaletteItems(input: { commands: typeof COMMANDS; has(id: string): boolean; rules: readonly ResolvedRule[]; platform: Platform; names: KeyNames; tabs: readonly Tab[]; sessions: readonly SessionSummary[]; t: Translate; navigate(item: ItemRef): void; run(id: string): void }): PaletteItem[]` (commands without a handler are left out; sessions limited to the 50 most recent).
  - `PaletteHost` registers `palette.toggle` and renders the lazy palette.

**Rulings (pre-dispatch):**
- FTS5 transcript hits (DESIGN §12's palette) arrive with M4. [M3R100]
- On phones the palette opens as a full-width sheet (Task 8's dialog rule). [M3R27]
- No digit chords in the palette (M3-RT-31, M3R73): the happy-dom test would pass while real browsers keep the keys. [M3R101]
- The palette is the first lazy chunk of the shell's command layer: it mounts through Task 21's `LazyBoundary` with `useRetryableLazy`, never a bare `Suspense` (M3-RT-15). [M3R99]

- [ ] **Step 1: Write the failing tests**

`rank.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeSearch, rankItems, type PaletteItem } from "./rank.ts";

const item = (id: string, group: PaletteItem["group"], title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id, group, title, searchTerms: [title], run: () => {}, ...extra });
const items = [
  item("a1", "actions", "Open settings"),
  item("a2", "actions", "Split pane"),
  item("s1", "sessions", "pi-agentic", { searchTerms: ["pi-agentic", "/home/ana/pi-agentic"], recency: 5 }),
  item("s2", "sessions", "settings-app", { recency: 9 }),
  item("g1", "settings", "Appearance", { searchTerms: ["Appearance", "theme density"] }),
];
const ids = (result: ReturnType<typeof rankItems>) => result.groups.flatMap((g) => g.items.map((i) => i.id));

describe("palette ranking (T3 CommandPalette.logic.ts)", () => {
  it("normalizes accents and case", () => {
    expect(normalizeSearch("Réglages Thème")).toBe("reglages theme");
  });
  it("keeps the natural order without a query", () => {
    expect(ids(rankItems(items, ""))).toEqual(["a1", "a2", "s1", "s2", "g1"]);
  });
  it("needs every token, prefers the title and exact or prefix matches", () => {
    expect(ids(rankItems(items, "settings"))).toEqual(["a1", "s2"]);
    expect(ids(rankItems(items, "theme"))).toEqual(["g1"]);
    expect(ids(rankItems(items, "open set"))).toEqual(["a1"]);
  });
  it("keeps actions only after >", () => {
    const result = rankItems(items, "> pane");
    expect([ids(result), result.actionsOnly]).toEqual([["a2"], true]);
  });
  it("renders at most 50 rows per group and counts them all", () => {
    const many = Array.from({ length: 80 }, (_, i) => item(`x${i}`, "sessions", `project ${i}`));
    const result = rankItems(many, "project");
    expect([result.groups[0]?.items.length, result.count]).toEqual([50, 80]);
  });
});
```

`CommandPalette.test.tsx` (`// @vitest-environment happy-dom`): opened with the items above, the dialog has `data-command-palette`, the input is focused and labelled `Search commands and sessions`; typing `split` leaves one option; Enter runs it and closes the palette; `Ctrl+2` in the input is not handled by the palette (`defaultPrevented` stays false, nothing runs); typing `zz` shows `No match. Try a folder, a setting or an action.`; typing `> zz` shows `No matching action.`; the polite live region reads `1 result` after `split`; the chord of an item with `chord: ["Ctrl", "\\"]` is shown as a `Kbd`.

`palette-items.test.ts`: commands whose handler is missing are not listed; a listed command carries the chord tokens of its last effective rule; sessions become items titled by their folder name with the full path as `detail`, limited to the 50 most recent; open tabs appear in group `open`; settings sections appear in group `settings`; `run` of a session item calls `navigate({ kind: "session", id })`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @pap/web add -E cmdk && pnpm test:unit apps/web/src/features/commands/palette apps/web/src/routes/shell/palette-items.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`rank.ts`:

```ts
export type PaletteGroup = "open" | "actions" | "sessions" | "settings";

export interface PaletteItem {
  readonly id: string;
  readonly group: PaletteGroup;
  readonly title: string;
  readonly detail?: string;
  readonly searchTerms: readonly string[];
  readonly chord?: readonly string[];
  readonly chordJoiner?: "" | "+";
  readonly recency?: number;
  run(): void;
}

const GROUP_ORDER: readonly PaletteGroup[] = ["open", "actions", "sessions", "settings"];

export const normalizeSearch = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

function score(item: PaletteItem, tokens: readonly string[]): number | null {
  const terms = item.searchTerms.map(normalizeSearch);
  const joined = terms.join(" ");
  if (!tokens.every((token) => joined.includes(token))) return null;
  const first = tokens[0] ?? "";
  const field = terms.findIndex((term) => term.includes(first));
  const title = normalizeSearch(item.title);
  const bonus = title === tokens.join(" ") ? 3 : title.startsWith(first) ? 2 : title.includes(first) ? 1 : 0;
  return 1000 - 100 * Math.max(field, 0) + bonus;
}

export function rankItems(items: readonly PaletteItem[], query: string, cap = 50): { groups: Array<{ group: PaletteGroup; items: PaletteItem[] }>; count: number; actionsOnly: boolean } {
  const trimmed = query.trim();
  const actionsOnly = trimmed.startsWith(">");
  const tokens = normalizeSearch(actionsOnly ? trimmed.slice(1) : trimmed).split(/\s+/).filter(Boolean);
  const pool = actionsOnly ? items.filter((item) => item.group === "actions") : items;
  const ranked = pool
    .map((item, order) => ({ item, order, score: tokens.length === 0 ? 0 : score(item, tokens) }))
    .filter((entry): entry is { item: PaletteItem; order: number; score: number } => entry.score !== null)
    .sort((a, b) => (tokens.length === 0 ? a.order - b.order : b.score - a.score || (b.item.recency ?? 0) - (a.item.recency ?? 0) || a.order - b.order));
  const groups = GROUP_ORDER.map((group) => ({ group, items: ranked.filter((entry) => entry.item.group === group).map((entry) => entry.item) }))
    .filter((group) => group.items.length > 0)
    .map((group) => ({ ...group, items: group.items.slice(0, cap) }));
  return { groups, count: ranked.length, actionsOnly };
}
```

(In the `"settings"` case `s2` scores higher than `a1` (prefix bonus), but groups render in `GROUP_ORDER`, so the action comes first in the flattened list; inside one group the score decides.)

`CommandPalette.tsx`: `Dialog variant="palette" hideTitle title={t("commands.palette.dialog")} closeLabel={t("ui.close")}`; inside, a wrapper `<div data-command-palette>` holding cmdk's `<Command shouldFilter={false} loop label={…}>` with `<Command.Input aria-label={t("commands.palette.input")} value={query} onValueChange={setQuery} />`, `<Command.List>` with one `<Command.Group heading={t(`commands.palette.group.${group}`)}>` per group and `<Command.Item value={item.id} onSelect={() => { onOpenChange(false); item.run(); }}>` rows (title, `detail` in `text-muted font-mono text-code truncate`, `Kbd` of `chord`; selected row `aria-selected:bg-surface-2`); `<Command.Empty>` with `commands.palette.empty` or `commands.palette.emptyActions`; a `<p className="sr-only" aria-live="polite">` with `t("commands.palette.count", { count })`. Strings: `commands.palette.dialog` "Command palette" / "Palette de commandes", `commands.palette.input` "Search commands and sessions" / "Rechercher des commandes et des sessions", `commands.palette.group.open|actions|sessions|settings` "Open" "Actions" "Sessions" "Settings" / "Ouverts" "Actions" "Sessions" "Réglages" (identical ones listed), `commands.palette.empty` "No match. Try a folder, a setting or an action." / "Aucun résultat. Essayez un dossier, un réglage ou une action.", `commands.palette.emptyActions` "No matching action." / "Aucune action correspondante.", `commands.palette.count` "{count} results" / "{count} résultats" (use a separate `…countOne` key for 1: "1 result" / "1 résultat"; no concatenation around the number).

`PaletteHost.tsx`: holds `open`, registers `palette.toggle` (toggles), builds items with `buildPaletteItems` from the stores when open, renders the palette from `useRetryableLazy(() => import("../../features/commands/palette/CommandPalette.tsx"))` inside `LazyBoundary` (no fallback: the first open loads in well under 100 ms locally, and DESIGN §7.3 shows nothing for that; `onError` closes the palette, retries on the next open and calls `notifyLazyFailure` with `shell.lazyFailed` / `shell.reload`), and refreshes the sessions cache on open. `PaletteHost.test.tsx`: with the palette module mocked to throw (`vi.mock`), `Ctrl+K` leaves the shell standing (the pane is still there), shows the error toast with "Reload", and a second `Ctrl+K` tries again (a second toast; the boundary re-armed).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web pnpm-lock.yaml
git commit -m "feat(commands): Cmd+K palette with ranked actions, open items, sessions and settings"
```

---

### Task 23: Phone shell — bottom nav, one pane, sheets, keyboard-safe viewport

DESIGN.md §8 (< 768 px): bottom nav Agents / Work / Lists / Inbox, one pane at a time, bottom sheets for menus (Task 8 already turns dialogs and menus into sheets). D19 ergonomics from pi-web (`hooks/useViewportHeight.ts`, `docs/agents/client-platform.md`): while an editor has focus and the visual viewport is more than 60 px shorter than the zoom-corrected inner height, `--app-viewport-height` follows the visual viewport and `<html data-keyboard-open>` is set; WebKit settles late (bugs.webkit.org 265578), so each trigger starts one non-restarting chain of re-reads; anything fixed to the bottom lives inside that height. The bottom nav hides while the keyboard is open.

**Files:**
- Create: `apps/web/src/routes/shell/use-viewport-height.ts`, `use-viewport-height.test.ts`, `MobileShell.tsx`, `MobileShell.test.tsx`, `BottomNav.tsx`, `TabSwitcher.tsx`
- Modify: `apps/web/src/routes/shell/AppShell.tsx` (phone branch via `useIsPhone()`), `apps/web/src/styles.css` (bottom nav and toast offset rules), `catalog/shell.ts`

**Interfaces:**
- Consumes: Tasks 8, 18–22, `useIsPhone` (Task 8).
- Produces:
  - `KEYBOARD_MIN_HEIGHT_PX = 60`; `shouldUseVisualViewportHeight(state: { hasFocusedEditable: boolean; innerHeight: number; viewportHeight: number; viewportScale: number }): boolean`; `useViewportHeight(): void`.
  - `type MobileSection = "agents" | "work" | "lists" | "inbox"`; `MobileShell(props as AppShell)`; `BottomNav({ section; onSection(section): void; inboxCount: number })`; `TabSwitcher({ open; onOpenChange })`.

**Rulings (pre-dispatch):**
- The Chat / Review / Term switch of DESIGN §8 appears only when the active item offers more than one pane kind; M3 has only chat, so it is absent until M8/M9. [M3R102]
- The "Agents" tab shows an empty state without an action until M11 creates agents. [M3R103]
- `interactive-widget=resizes-content` (Task 11's viewport meta, T3) helps Chrome on Android; iOS relies on the hook. [M3R104]
- The phone top bar's `Mark` is decorative (not a link, `aria-hidden`), so no small tap target sits there (M3-RT-35's point, kept although the browser probe is deferred). [M3R105]

- [ ] **Step 1: Write the failing tests**

`use-viewport-height.test.ts` (port of pi-web's cases):

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { KEYBOARD_MIN_HEIGHT_PX, shouldUseVisualViewportHeight } from "./use-viewport-height.ts";

describe("keyboard detection (pw hooks/useViewportHeight.ts)", () => {
  it("needs a focused editor", () => {
    expect(shouldUseVisualViewportHeight({ hasFocusedEditable: false, innerHeight: 800, viewportHeight: 400, viewportScale: 1 })).toBe(false);
  });
  it("ignores toolbar-sized shrinks and accepts keyboard-sized ones", () => {
    expect(shouldUseVisualViewportHeight({ hasFocusedEditable: true, innerHeight: 800, viewportHeight: 800 - KEYBOARD_MIN_HEIGHT_PX, viewportScale: 1 })).toBe(false);
    expect(shouldUseVisualViewportHeight({ hasFocusedEditable: true, innerHeight: 800, viewportHeight: 500, viewportScale: 1 })).toBe(true);
  });
  it("compares against the zoom-corrected height", () => {
    expect(shouldUseVisualViewportHeight({ hasFocusedEditable: true, innerHeight: 800, viewportHeight: 400, viewportScale: 2 })).toBe(false);
    expect(shouldUseVisualViewportHeight({ hasFocusedEditable: true, innerHeight: 800, viewportHeight: 300, viewportScale: 2 })).toBe(true);
  });
});
```

and, with a fake `window.visualViewport` (height 400, scale 1, an `addEventListener` store) and fake timers: focusing an input then dispatching `resize` sets `--app-viewport-height: 400px` and `data-keyboard-open` after the frame; blurring clears both; a second trigger during the settle chain does not restart it (count the timers created: 5); unmount removes every listener, timer and attribute.

`MobileShell.test.tsx` (shell bed with `window.matchMedia` reporting a phone): a `nav` labelled `Sections` with four buttons `Agents`, `Work`, `Lists`, `Inbox`, `Work` with `aria-current="page"`; no element with `data-slot="rail"`; `Agents` shows the `No agent yet` empty state; `Lists` shows the session tree, and picking a session navigates to `/s/<id>` and returns to `Work`; `Inbox` shows `Nothing waits for you`; the tab switcher button opens a sheet listing the open tabs; with `data-keyboard-open` on `<html>`, the bottom nav is hidden (`getComputedStyle` is not reliable in happy-dom: assert the nav carries `data-slot="bottom-nav"` and that `styles.css` contains `html[data-keyboard-open] [data-slot="bottom-nav"]` with `display: none` — read the file in the test).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/routes/shell`
Expected: FAIL.

- [ ] **Step 3: Implement**

`use-viewport-height.ts`: port pi-web's hook (constants `KEYBOARD_MIN_HEIGHT_PX = 60`, `SETTLE_DELAYS_MS = [48, 120, 240, 420, 720]`, the same triggers: visualViewport `resize`/`scroll`, window `resize`/`focusin`/`focusout`/`pageshow`, document composition/input/keyup on a focused editor; the same cleanup) with `shouldUseVisualViewportHeight` exported. Called once by `AppShell` in both layouts.

`MobileShell.tsx`: `<div data-shell="mobile" className="flex h-app flex-col">` → top bar (`h-bar`, a decorative `Mark` size 20 (no link, no label), the active title, an `IconButton icon={IconSearch}` running `palette.toggle`, an `IconButton icon={IconLists}` (label `shell.mobile.tabs`) opening `TabSwitcher`), `ConnectionBanner`, `<div className="min-h-0 flex-1 overflow-y-auto">` (not `<main>`, as on desktop, until P3) with the section's content (agents → `EmptyState` `shell.agents.emptyTitle` "No agent yet" / "Aucun agent pour l'instant", `shell.agents.emptyPurpose` "A long-term agent has its own thread, memory, budget and triggers." / "Un agent de long terme a son propre fil, sa mémoire, son budget et ses déclencheurs."; work → `PaneHost` with the active tab, no split; lists → `SessionTree`; inbox → the Inbox empty state), then `BottomNav`. Navigating to an item (path change) selects `work`.

`BottomNav.tsx`: `<nav aria-label={t("shell.mobile.sections")} data-slot="bottom-nav" className="grid shrink-0 grid-cols-4 border-t border-border bg-bg-side pb-safe">` with four buttons (`IconAgents`, `IconWork`, `IconLists`, `IconInbox`, each with its label under the icon in `label-hud`, `min-h-11`, `aria-current="page"` on the selected one, the Inbox one with a `Badge` when `inboxCount > 0`).

`styles.css` additions:

```css
html[data-keyboard-open] [data-slot="bottom-nav"] {
  display: none;
}

[data-shell="mobile"] {
  --toast-bottom: calc(var(--bar-h) + 2.75rem + env(safe-area-inset-bottom, 0px));
}
```

and, to lift toasts above the bottom nav (Task 8's viewport carries `data-slot="toast-viewport"`), `html:has([data-shell="mobile"]) [data-slot="toast-viewport"] { bottom: var(--toast-bottom); }` (`:has()` is in Safari 15.4+).

`TabSwitcher.tsx`: `Dialog variant="sheet"` titled `shell.mobile.tabs` ("Open items" / "Éléments ouverts") listing open tabs as full-width buttons (select → navigate, close) with `pointer-coarse:min-h-11`.

New keys: `shell.mobile.sections` "Sections" / "Sections" (identical), `shell.mobile.agents` "Agents" (identical), `shell.mobile.work` "Work" / "Travail", `shell.mobile.lists` "Lists" / "Listes", `shell.mobile.inbox` "Inbox" / "Boîte", `shell.mobile.tabs`, and the agents empty state.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm test:unit scripts/class-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(shell): phone layout with bottom nav, tab switcher and keyboard-safe viewport"
```

---
# Phase 7 — Settings screens

### Task 24: Settings screen, Language, Account & devices, and the restyled sign-in screens

DESIGN.md §10 (screen 08): Settings opens as a tab, with a section list on the left (Personal: Appearance, Keyboard shortcuts, Language, Account & devices; the Platform sections — models, MCP, skills, agents, automation, security, health — arrive with their milestones) and the section on the right. On phones a section picker replaces the list. "Add a passkey" and "Sign out" move here from M1's account bar. The sign-in and setup screens get the Night Control look of screen 12 (logo and wordmark, passkey first, password second, the throttle note).

**Files:**
- Create: `apps/web/src/routes/settings/SettingsScreen.tsx`, `SettingsScreen.test.tsx`, `sections.tsx`, `LanguageSection.tsx`, `AccountSection.tsx`, `sections.test.tsx`, `apps/web/src/routes/shell/pane-renderers.test.tsx`
- Modify: `apps/web/src/build-output.int.test.ts` (Settings stays out of the initial assets)
- Create: `apps/web/src/routes/shell/shell-context.ts` (username, passkeys, sign-out for sections)
- Modify: `apps/web/src/routes/shell/pane-renderers.tsx` (`settings` → the lazy `SettingsScreen`, owner R3-5), `AppShell.tsx` (context provider)
- Modify: `apps/web/src/features/auth/LoginScreen.tsx`, `SetupScreen.tsx`, `AddPasskey.tsx` (look and `useT` only; behaviour and their M1 tests unchanged), `LoginScreen.test.tsx` (throttle note)
- Modify: `apps/web/src/i18n/catalog/settings.ts`

**Interfaces:**
- Consumes: Tasks 3 (`switchLocale`, `useT`), 6–8, 18 (`SETTINGS_SECTIONS`, `pathOfItem`), 19.
- Produces:
  - `ShellContext` / `useShell(): { username: string | null; passkeysAvailable: boolean; onSignedOut(): void }`.
  - `SETTINGS_SECTION_RENDERERS: Record<SettingsSection, () => ReactNode>` (`language` and `account` here; `appearance` and `shortcuts` render a one-line `EmptyState` until Tasks 25 and 27 replace them in this map).
  - `SettingsScreen({ section: SettingsSection })`.

**Rulings (pre-dispatch):**
- The first-run stepper of screen 12 (account → passkey → Pi) is deferred to M7, where the Pi step (providers) exists; setup stays one step (owner M3-Q7). [M3R106]
- "Connected devices" (spec C §4.4) is M5's; the Account section shows the username, passkeys and sign-out only. [M3R107]
- The throttle note says what `apps/daemon/src/modules/auth/throttle.ts` does (owner R3-9): the wait starts at the first failed attempt (1 s), doubles with each one up to a minute, per address and per account, and resets after five minutes without a failure. Screen 12's "After 5 attempts" overclaims and is not used. [M3R108]
- The Settings screen, with all its sections, is a lazy chunk (owner R3-5, agreement 10): `pane-renderers.tsx` renders it through `useRetryableLazy` + `LazyBoundary` (Task 21); the sections import statically inside that chunk. [M3R109]
- The language is per device (owner R3-3): `switchLocale` stores `pap.locale` in `localStorage` only. [M3R15]

- [ ] **Step 1: Write the failing tests**

`SettingsScreen.test.tsx` (shell bed at `/settings/language`): a `nav` labelled `Settings sections` lists `Appearance`, `Keyboard shortcuts`, `Language`, `Account & devices` with `aria-current="page"` on Language; clicking `Account & devices` navigates to `/settings/account`; with `matchMedia` reporting a phone, the list is replaced by a `Select` labelled `Section` whose value is the current section; only one settings tab exists while moving between sections.

`sections.test.tsx`:
- Language: choosing `Français` switches the page language at once — the nav entry reads `Langue` and `document.documentElement.lang` is `fr` — with no reload; with `localStorage.setItem` throwing, a status banner says `Applied to this page only: this browser does not keep settings.` (in French after the switch: assert the French text).
- Account: shows the username; `Add a passkey` is present only when passkeys are available; `Sign out` calls `logout` then `onSignedOut`; a failed `logout` shows the error toast and keeps the session screen.
- `LoginScreen.test.tsx` gains: the throttle note "Each failed attempt doubles the wait before the next one, from 1 second up to 1 minute, per address and per account. It resets after 5 minutes without a failure." is shown under the password form; the passkey button still comes first.
- `pane-renderers.test.tsx` (shell bed at `/settings/language`): the Settings screen appears once its chunk has loaded (`vi.waitFor`, 2 s); `build-output.int.test.ts` gains "keeps the Settings screen out of the initial assets": no initial JS contains `data-settings-screen` (the marker the screen's root carries) and some lazy asset does.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/routes/settings apps/web/src/features/auth`
Expected: FAIL.

- [ ] **Step 3: Implement**

`SettingsScreen.tsx`: `<div className="flex min-h-0 flex-1">` with, on desktop, `<nav aria-label={t("settings.nav.label")} className="w-56 shrink-0 border-r border-border bg-bg-side p-s2">` holding a `label-hud text-muted` group heading (`settings.nav.personal`) and one `Link` per section (`flex h-control items-center rounded-sm px-s2 text-ui`, current: `bg-surface-2 text-fg` + a 2 px agent rule; DESIGN's selected-item rule), and `<section className="min-w-0 flex-1 overflow-y-auto p-s4" aria-labelledby=…>` with an `h1` (`text-h1`) and `SETTINGS_SECTION_RENDERERS[section]()`. On phones (`useIsPhone()`), a `Select` labelled `settings.nav.section` replaces the nav (`onChange` navigates). Changing section navigates to `pathOfItem({ kind: "settings", section })`, which updates the one settings tab (Task 18).

`LanguageSection.tsx`: `Segmented` labelled `settings.language.label` with options `en` → `t("settings.language.en")` ("English"), `fr` → `t("settings.language.fr")` ("Français") and value `useLocale()`; `onChange` → `const stored = switchLocale(locale)`; when `stored` is false, `Banner tone="capacity"` with `settings.language.notStored`.

`AccountSection.tsx`: the username in `font-mono`, `AddPasskey` (existing component, its "Passkey added." status now rendered here in a `role="status"` line) when `passkeysAvailable`, and `Button variant="secondary"` `settings.account.signOut` with the same `logout().then(onSignedOut, toast)` as the rail.

`LoginScreen` / `SetupScreen` / `AddPasskey`: switch `t` to `useT()`; layout `<main className="flex min-h-full items-center justify-center p-s4">` around `<div className="flex w-full max-w-sm flex-col gap-s4 rounded-md border border-border-strong bg-surface p-s5">` headed by `Mark size={32}` + `Wordmark name={t("app.name")} tagline={t("app.tagline")}`; title `text-h1`; Login adds `<p className="text-ui text-muted">{t("login.throttleNote")}</p>` under the form. No behaviour, label or button text changes (M1 tests and the deferred e2e journey select by them). `SettingsScreen`'s root carries `data-settings-screen` for the build test.

New keys (en / fr): `app.tagline` "pi agentic platform" (identical: add to `IDENTICAL_IN_FR`), `login.throttleNote` "Each failed attempt doubles the wait before the next one, from 1 second up to 1 minute, per address and per account. It resets after 5 minutes without a failure." / "Chaque échec double l'attente avant l'essai suivant, de 1 seconde jusqu'à 1 minute, par adresse et par compte. Elle repart de zéro après 5 minutes sans échec.", `settings.nav.label` "Settings sections" / "Sections des réglages", `settings.nav.personal` "Personal" / "Personnel", `settings.nav.section` "Section" / "Section" (identical), `settings.section.appearance` "Appearance" / "Apparence", `settings.section.shortcuts` "Keyboard shortcuts" / "Raccourcis clavier", `settings.section.language` "Language" / "Langue", `settings.section.account` "Account & devices" / "Compte et appareils", `settings.language.label` "Language" / "Langue", `settings.language.notStored` "Applied to this page only: this browser does not keep settings." / "Appliqué à cette page seulement : ce navigateur ne garde pas les réglages.", `settings.account.username` "Signed in as" / "Connecté en tant que", `settings.account.signOut` "Sign out" / "Se déconnecter".

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm test:unit scripts/literal-coverage.test.ts && pnpm test:int apps/web/src/build-output.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(settings): lazy settings screen with language and account sections; restyled sign-in"
```

---

### Task 25: Settings › Appearance — account and device controls, live, with reset and Undo

DESIGN.md §13 and screen 08: every change applies at once (the app is the live preview, plus a small sample); "Reset to defaults" covers both scopes and offers Undo for 5 s (DESIGN §9.1 toast); the account scope says whether it is saved; the device scope says when the browser refuses to keep it.

**Files:**
- Create: `apps/web/src/features/appearance/AppearancePanel.tsx`, `ThemeSection.tsx`, `ReadingSection.tsx`, `DetailsSection.tsx`, `AppearancePreview.tsx`, `AppearancePanel.test.tsx`
- Modify: `apps/web/src/routes/settings/sections.tsx` (`appearance` → `AppearancePanel`), `apps/web/src/features/appearance/index.ts` (+ `AppearancePanel`), `catalog/settings.ts`, `apps/web/src/build-output.int.test.ts` (the markdown renderer stays a lazy chunk)

**Interfaces:**
- Consumes: Task 15 store (`account`, `device`, `accountStatus`, `deviceStored`, setters, `resetAll`), Task 13 (`SIZE_RANGES`, `DEFAULT_DEVICE`), primitives, AI components (preview).
- Produces: `AppearancePanel()`.

**Rulings (pre-dispatch):**
- Font choices are the bundled Manrope and JetBrains Mono or the system stacks; no CDN and no arbitrary installed fonts (T3 lists installed fonts, which needs a permission prompt; owner M3-Q8). [M3R110]
- Size sliders: UI 12–16 px, chat 13–18 px, code 11–16 px, each with "follow density". [M3R111]
- Chat width options Full (default, decision 28), Wide (64rem), Narrow (48rem). [M3R112]
- "Reset to defaults" keeps the custom theme library (owner R3-2, M3R62); the status line never claims more than the account document knows (`local` shows no line). [M3R113]
- The preview's agent message renders through `Markdown` (Task 10b), which puts the markdown renderer into the production build as a lazy chunk; the build-output test pins that it stays out of the initial assets. [M3R41]

- [ ] **Step 1: Write the failing tests**

`AppearancePanel.test.tsx` (`// @vitest-environment happy-dom`; `TooltipProvider` + `Toaster`; reset the store before each test):
- "mode Night/Day/System writes the account scope": click `Day` in the `Mode` segmented → `account.mode === "day"`.
- "the dark theme lists Night Control, High contrast and dark custom themes; the light one Day · Papier and light custom themes": with a custom night theme `Ocean` in the account, the `Dark theme` select's trigger shows `Night Control` and its options (open via keyboard) include `High contrast` and `Ocean`, not `Day · Papier`.
- "density and sizes write the device scope; Follow density clears a size": click `Comfortable` → `device.density === "comfortable"`; move the `UI size` slider to 15 (Radix slider: press ArrowRight on the thumb twice from the density default 13) → `device.uiSize === 15`; click `Follow density` → `null`.
- "switches write the account scope": `Uppercase labels` off → `uppercaseLabels: false`; `Background grid` off → `grid: false`; `Rail position` Right, `Agent avatars` Glyph, `Tool card detail` Full.
- "motion and chat width write the device scope": `None` → `motion: "none"`; `Narrow` → `chatWidth: "narrow"`.
- "reset covers both scopes, keeps the custom themes, and Undo restores them": with a custom theme `Ocean` in the account and after the changes above, click `Reset to defaults` → both scopes are the defaults except `customThemes`, which still holds `Ocean`; a toast `Appearance reset` with `Undo` is shown; click `Undo` → the changed values are back.
- "says where the account copy stands": `accountStatus` `local` → no status line; `saving` → `Saving…`; `saved` → `Saved to your account`; `error` → `Not saved to your account. Your next change tries again.`; `load-error` → `Showing this device's copy: your saved appearance could not be loaded. Changes stay on this device until it loads.`; `deviceStored: false` → `This browser does not keep device settings: they apply to this page only.`
- "the preview shows a you message, an agent message, a tool card and a primary button": the `Preview` region contains `[data-slot="message"][data-author="you"]`, `[data-author="agent"]`, `[data-slot="tool-card"]`, `[data-variant="primary"]`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/appearance/AppearancePanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`AppearancePanel.tsx`: a header row (`h2` `settings.appearance.title`, the status line, `Button variant="secondary"` `settings.appearance.reset` → `const previous = resetAll(); toast({ message: t("settings.appearance.resetDone"), action: { label: t("settings.appearance.undo"), altText: t("settings.appearance.undoAlt"), run: () => { setAccount(previous.account); setDevice(previous.device); } } })`), the `deviceStored` banner, then `ThemeSection`, `ReadingSection`, `DetailsSection`, and `AppearancePreview` beside them on wide screens (stacked under 1024 px). Each section is a `<section aria-labelledby>` with a `label-hud` heading and a scope hint (`settings.appearance.scopeAccount` "Your account, on every device" / "Votre compte, sur tous vos appareils"; `settings.appearance.scopeDevice` "This device" / "Cet appareil").

`ThemeSection.tsx` (account): `Segmented` Mode (`night`/`day`/`system` → `settings.appearance.mode.*`), `Select` Dark theme (`night` → "Night Control" (identical), `hc` → `settings.appearance.preset.hc` "High contrast" / "Contraste élevé", plus custom themes with `base: "night"` by name), `Select` Light theme (`day` → `settings.appearance.preset.day` "Day · Papier" / "Jour · Papier", plus `base: "day"` custom themes). Task 26 adds the custom theme list and editor below.

`ReadingSection.tsx` (device): `Segmented` Density; three `Slider`s (`SIZE_RANGES`, `valueText` `t("settings.appearance.px", { value })`), each followed by a `Button variant="ghost" size="sm"` `settings.appearance.followDensity` shown when the size is not null; `Segmented` Chat width (`full`/`wide`/`narrow`); `Segmented` Motion (`system`/`reduced`/`none`).

`DetailsSection.tsx` (account): `Select` UI font (`manrope` "Manrope", `system` `settings.appearance.fontSystem` "System font" / "Police du système"), `Select` Mono font (`jetbrains-mono` "JetBrains Mono", `system`), `Switch` Uppercase labels, `Switch` Background grid, `Segmented` Rail position, `Segmented` Agent avatars (`outlined`/`tinted`/`glyph`), `Segmented` Tool card detail (`compact`/`expanded`/`full`).

`AppearancePreview.tsx`: `<section aria-label={t("settings.appearance.preview")}>` with `Message author="you"`, `Message author="agent"` whose body is `<Markdown text={t("settings.appearance.sample.agent")} />` (a sample with one inline code span; sample texts from `settings.appearance.sample.*` keys), `ToolCard detail={account.toolDetail}` (`bash`, a sample summary and duration), an `Avatar avatarStyle={account.avatarStyle}`, a `Chip tone="att"` and a primary `Button`.

All strings: `settings.appearance.*` keys in en and fr (sentence case; preset and font proper names listed in `IDENTICAL_IN_FR`).

- [ ] **Step 4: Run the tests**

Add to `apps/web/src/build-output.int.test.ts`:

```ts
  it("keeps the markdown renderer and the highlighter out of the initial assets (owner R3-1, R3-5)", async () => {
    const initial = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1] ?? "");
    for (const name of initial) expect(await readFile(join(out, "assets", name), "utf8"), name).not.toMatch(/data-markdown-body|pap-code/);
    const all = await Promise.all(assets.filter((name) => name.endsWith(".js")).map((name) => readFile(join(out, "assets", name), "utf8")));
    expect(all.some((code) => code.includes("data-markdown-body"))).toBe(true);
  });
```

Run: `pnpm test:unit apps/web && pnpm test:unit scripts/literal-coverage.test.ts scripts/class-coverage.test.ts && pnpm test:int apps/web/src/build-output.int.test.ts`
Expected: PASS (apply the provisional-budget rule if the initial size crosses `budgets.json`).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(appearance): settings panel for theme, density, sizes, fonts, details and motion"
```

---

### Task 26: Custom theme editor — roles, contrast per role, JSON import and export

DESIGN.md §13.1 and §12: a custom theme edits eight roles; the editor shows the WCAG ratio per role and asks for confirmation below AA; themes import and export as JSON (T3: `ThemeEditorPanel.tsx`, `serializeThemeFile`, import dialogs). Imported text is untrusted (Review Focus 3): parsed with the contracts schema, capped in size, and only hex colours ever reach a style property.

**Files:**
- Create: `apps/web/src/features/appearance/theme-io.ts`, `theme-io.test.ts`, `ThemeEditor.tsx` (lazy chunk, default export too), `ThemeEditor.test.tsx`, `CustomThemes.tsx`
- Modify: `apps/web/src/features/appearance/ThemeSection.tsx` (list + editor entry points), `catalog/settings.ts`

**Interfaces:**
- Consumes: `CustomTheme` (Task 12), `deriveTheme`, `tokenVars`, `roleChecks` (Task 13), store (Task 15), `PRESET_TOKENS` (Task 1a), `Dialog`, `TextField`, `Segmented`, `Chip`, `toast`.
- Produces:
  - `MAX_THEME_FILE_BYTES = 16384`; `type ThemeFileError = { kind: "too_large" } | { kind: "not_json" } | { kind: "invalid"; path: string }`; `parseThemeFile(text: string): { ok: true; theme: Omit<CustomTheme, "id"> } | { ok: false; errors: ThemeFileError[] }` (at most 20 errors); `exportThemeFile(theme: CustomTheme): string` (DESIGN §13.1 shape, no `id`, 2-space JSON); `newThemeId(name: string, taken: ReadonlySet<string>): string` (T3 id rule, unique among `taken` and the preset ids, `theme` fallback for a name with no ASCII letters); `presetRoles(theme: ThemeName): CustomTheme["roles"]` (a preset as the eight roles of a custom theme: its fills for agent, you and attention).
  - `ThemeEditor({ open; onOpenChange; initial: Omit<CustomTheme, "id">; onSave(theme: Omit<CustomTheme, "id">): void })`; `CustomThemes()` (list: Edit, Duplicate, Export, Delete; Import; "Duplicate & edit" from a preset; disabled at 16 themes with a hint).

**Rulings (pre-dispatch):**
- Deleting a custom theme in use switches that side back to its preset (Night Control or Day · Papier), with Undo. [M3R114]
- The native colour input (`<input type="color">`, Safari 16.4 supports it) sits next to a hex field. [M3R115]
- A new id never takes a preset's id (`night`, `day`, `hc`): `newThemeId` treats them as taken, and the contracts refuse them anyway (M3-RT-09). [M3R49]
- "Duplicate & edit" from a preset takes its fills as the agent, you and attention roles (`presetRoles`), never the darkened text tones, so the copy's primary button keeps the you fill (M3-RT-32). [M3R116]
- The theme editor is a lazy chunk (owner R3-5): `CustomThemes` opens it through `useRetryableLazy` + `LazyBoundary` + `notifyLazyFailure` (Task 21). [M3R117]
- Imported text is untrusted (Review Focus 3): size first, then JSON, then the contracts schema; only hex colours reach a style property. [M3R118]

- [ ] **Step 1: Write the failing tests**

`theme-io.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveTheme } from "./derive.ts";
import { exportThemeFile, MAX_THEME_FILE_BYTES, newThemeId, parseThemeFile, presetRoles } from "./theme-io.ts";

const example = '{"name":"My theme","base":"night","roles":{"bg":"#0E1626","surface":"#132033","agent":"#38BDF8","you":"#FB923C","attn":"#EC4899","ok":"#34D399","err":"#F87171","text":"#E6EDF7"}}';

describe("theme files (DESIGN.md §13.1)", () => {
  it("reads DESIGN's example and writes it back without an id", () => {
    const parsed = parseThemeFile(example);
    if (!parsed.ok) throw new Error("parse");
    expect(parsed.theme.name).toBe("My theme");
    expect(JSON.parse(exportThemeFile({ id: "x", ...parsed.theme }))).toEqual(JSON.parse(example));
  });
  it("says what is wrong, entry by entry", () => {
    expect(parseThemeFile("{oops")).toEqual({ ok: false, errors: [{ kind: "not_json" }] });
    expect(parseThemeFile("x".repeat(MAX_THEME_FILE_BYTES + 1))).toEqual({ ok: false, errors: [{ kind: "too_large" }] });
    const hostile = JSON.parse(example);
    hostile.roles.bg = "url(https://x.test/a.png)";
    delete hostile.roles.agent;
    const result = parseThemeFile(JSON.stringify(hostile));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => (e.kind === "invalid" ? e.path : e.kind)).sort()).toEqual(["roles.agent", "roles.bg"]);
  });
  it("makes unique ids that follow the id rule and never take a preset's id", () => {
    expect(newThemeId("My Theme!", new Set())).toBe("my-theme");
    expect(newThemeId("My Theme!", new Set(["my-theme"]))).toBe("my-theme-2");
    expect(newThemeId("夜", new Set())).toBe("theme");
    expect([newThemeId("Day", new Set()), newThemeId("HC", new Set())]).toEqual(["day-2", "hc-2"]);
  });

  it("duplicates a preset with its fills as roles, so the primary button keeps the you fill (M3-RT-32)", () => {
    expect(presetRoles("day")).toMatchObject({ agent: "#7c3aed", you: "#fb923c", attn: "#db2777", bg: "#faf9f6" });
    expect(deriveTheme({ id: "copy", name: "copy", base: "day", roles: presetRoles("day") })["you-fill"]).toBe("#fb923c");
  });
});
```

`ThemeEditor.test.tsx`: editing the `Text` role's hex field to `#1A2333` (unreadable on the example's background) turns its chip to `Below AA` with the ratio in tabular figures; `Save` then opens a confirmation dialog listing `Text` and its ratio, `Keep editing` closes it without calling `onSave`, `Save anyway` calls `onSave` with the edited roles; an invalid hex (`#12`) disables Save and marks the field invalid; the preview region carries `data-theme="night"` and an inline `--bg` equal to the role (and nothing but hex values in its style); `Import` with a file whose text is the hostile JSON above lists `roles.bg` and `roles.agent` errors and leaves the fields as they were.

`CustomThemes` (in the same test file): `Duplicate & edit` from `Night Control` opens the editor (once its chunk has loaded: `vi.waitFor`, 2 s) with `presetRoles("night")` and the name `Night Control copy`; saving adds a theme with a fresh id; deleting the theme in use as the dark theme sets `darkTheme` back to `night` and shows a toast with Undo; with 16 custom themes, `Duplicate & edit` is disabled and says why.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/appearance`
Expected: FAIL.

- [ ] **Step 3: Implement**

`theme-io.ts`:

```ts
import { CustomTheme, PRESET_THEME_IDS } from "@pap/contracts";
import { PRESET_TOKENS, type ThemeName } from "@pap/ui";

export const MAX_THEME_FILE_BYTES = 16_384;
const MAX_ERRORS = 20;
const ThemeFile = CustomTheme.omit({ id: true });

export type ThemeFileError = { readonly kind: "too_large" } | { readonly kind: "not_json" } | { readonly kind: "invalid"; readonly path: string };

/** Imported text is untrusted: size first, then JSON, then the contracts schema (only hex colours pass). */
export function parseThemeFile(text: string): { ok: true; theme: Omit<CustomTheme, "id"> } | { ok: false; errors: ThemeFileError[] } {
  if (new TextEncoder().encode(text).length > MAX_THEME_FILE_BYTES) return { ok: false, errors: [{ kind: "too_large" }] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ kind: "not_json" }] };
  }
  const parsed = ThemeFile.safeParse(value);
  if (parsed.success) return { ok: true, theme: parsed.data };
  return { ok: false, errors: parsed.error.issues.slice(0, MAX_ERRORS).map((issue) => ({ kind: "invalid", path: issue.path.join(".") })) };
}

export function exportThemeFile(theme: CustomTheme): string {
  const { name, base, roles } = theme;
  return `${JSON.stringify({ name, base, roles }, null, 2)}\n`;
}

/** T3's id rule (^[a-z0-9][a-z0-9-]{0,47}$), unique among `taken` and never a preset's id (M3-RT-09). */
export function newThemeId(name: string, taken: ReadonlySet<string>): string {
  const used = new Set<string>([...taken, ...PRESET_THEME_IDS]);
  const slug = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "theme";
  if (!used.has(slug)) return slug;
  for (let n = 2; n < 1000; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
  return `${slug}-${Date.now().toString(36)}`.slice(0, 48);
}

/** A preset as a custom theme's eight roles: the fills, not the darkened text tones, for agent, you and attention. */
export function presetRoles(theme: ThemeName): CustomTheme["roles"] {
  const t = PRESET_TOKENS[theme];
  return { bg: t.bg, surface: t.surface, text: t.text, agent: t["agent-fill"], you: t["you-fill"], attn: t["attn-fill"], ok: t.ok, err: t.err };
}
```

`ThemeEditor.tsx`: `Dialog` (`settings.theme.editorTitle`) with a name `TextField`, a base `Segmented` (`night`/`day`), one row per role in `THEME_ROLES` order (label `settings.theme.role.<role>`, `<input type="color" aria-label=…>` bound to the role, a hex `TextField` validated against `/^#[0-9a-fA-F]{6}$/`, the role's `RoleCheck` as `Chip tone={passes ? "ok" : "att"} label={passes ? t("settings.theme.aa") : t("settings.theme.belowAa")}` followed by the ratio `formatRatio` (one decimal, `tabular-nums`), and "adjusted to #xxxxxx" when `adjusted`), the fills' checks under them, and a preview `<div data-theme={base} style={tokenVars(deriveTheme(draft))}>` containing a you message, an agent message and a primary button. Save: invalid hex → disabled; any failing check → a second `Dialog` (`settings.theme.confirmTitle` "Save below AA contrast?" / "Enregistrer sous le contraste AA ?", listing the failing roles and ratios) with `Keep editing` and `Save anyway`. Import: a hidden `<input type="file" accept="application/json,.json">` read with `file.text()` after checking `file.size <= MAX_THEME_FILE_BYTES`; errors shown as a list (`settings.theme.importError.*`). Export: `URL.createObjectURL(new Blob([exportThemeFile(theme)], { type: "application/json" }))` on a temporary `<a download="<id>.json">`, revoked right after the click.

`CustomThemes.tsx`: list of `account.customThemes` (name, base chip, Edit / Duplicate / Export / Delete as `IconButton`s with labels), `Import` and `Duplicate & edit` (a `Menu` of the three presets, built with `presetRoles`; High contrast duplicates on a night base), all disabled at 16 themes with `settings.theme.limit` ("16 custom themes at most. Delete one to add another." / "16 thèmes personnalisés au plus. Supprimez-en un pour en ajouter un autre."). Saving a new theme: `setAccount({ ...account, customThemes: [...account.customThemes, { id: newThemeId(name, ids), ...theme }] })`. Deleting the theme in use resets that side to its preset and offers Undo. The editor dialog renders from `useRetryableLazy(() => import("./ThemeEditor.tsx"))` inside `LazyBoundary` (Task 21's `lib/lazy.tsx`); its `onError` closes the editor, retries next time and calls `notifyLazyFailure` with the translated `shell.lazyFailed` / `shell.reload`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm test:unit scripts/literal-coverage.test.ts scripts/class-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(appearance): custom theme editor with contrast per role and JSON import and export"
```

---

### Task 27: Settings › Keyboard shortcuts — table, recorder, conflicts, JSON

Spec C §7.4: "A keybindings JSON file with `when` clauses, plus an editor in Settings." T3's editor (`components/settings/KeybindingsSettings.tsx`): search, sections per area, a source badge (Default / Custom), a key pill that turns into a capture field, reset and remove per row, conflict warnings (`keybindingConflictLabels`); Orca's recorder (`ShortcutRecorderButton.tsx`): a button with `aria-pressed` and a `data-shortcut-recorder` marker the dispatcher skips, "Press keys…", Escape cancels, "Include at least one modifier key". Plus a JSON view of the user rules with per-entry errors (T3 reports invalid entries by index), import and export. Browser-reserved chords are refused by the recorder and flagged in the JSON view (Review Focus 4).

**Files:**
- Create: `apps/web/src/features/commands/editor/ShortcutsEditor.tsx`, `ShortcutRow.tsx`, `ShortcutRecorder.tsx`, `KeybindingsJson.tsx`, `keybindings-io.ts`, `keybindings-io.test.ts`, `ShortcutsEditor.test.tsx`
- Modify: `apps/web/src/routes/settings/sections.tsx` (`shortcuts` → `ShortcutsEditor`), `apps/web/src/features/commands/index.ts` (+ `ShortcutsEditor`), `catalog/commands.ts`

**Interfaces:**
- Consumes: Tasks 12, 16a, 16b, 17b (`useKeybindingsStore`, `COMMANDS`, `DEFAULT_KEYBINDINGS`, `chordFromEvent`, `parseChord`, `isReserved`, `conflictsOf`, `chordTokens`, `keyNames`), primitives.
- Produces:
  - `MAX_KEYBINDINGS_FILE_BYTES = 65536`; `parseKeybindingsFile(text: string): { ok: true; rules: KeybindingRule[]; issues: Array<{ index: number; problem: "shape" | "key" | "when" | "command" | "reserved" }> } | { ok: false; error: "too_large" | "not_json" | "not_array" | "too_many" }` (entries that fail the rule shape are reported and dropped; `reserved` is a warning, the rule is kept); `exportKeybindingsFile(rules: readonly KeybindingRule[]): string`.
  - `recordedChordProblem(chord: string, command: string, platform): "no_modifier" | "reserved" | null` (bare keys allowed only for `shortcuts.help` and function keys).
  - `ShortcutsEditor()`.

**Rulings (pre-dispatch):**
- A conflict is a warning (T3), not a refusal (Orca); a reserved chord is refused by the recorder and only warned in JSON. [M3R119]
- No visual `when` builder (T3 has one): `when` is edited in the JSON view only. A recorded chord keeps the command's default `when` clause (so `!panelFocus` and the rest survive a rebinding); a rule written in JSON without `panelFocus` still never fires inside a terminal-input panel (Task 16b's guard). [M3R120]
- The recorder stores digits and punctuation by physical key (owner R3-7, Task 16a). [M3R68]
- The editor is part of the lazy Settings chunk (Task 24), not a chunk of its own: it only shows inside Settings. [M3R121]

- [ ] **Step 1: Write the failing tests**

`keybindings-io.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { exportKeybindingsFile, MAX_KEYBINDINGS_FILE_BYTES, parseKeybindingsFile } from "./keybindings-io.ts";

describe("keybindings files", () => {
  it("keeps valid rules, reports each bad entry by index, and warns on reserved chords", () => {
    const text = JSON.stringify([
      { key: "mod+shift+p", command: "palette.toggle" },
      { key: "mod+k", command: "rm -rf" },
      { key: "mod+banana", command: "palette.toggle" },
      { key: "mod+j", command: "tab.close", when: "a &&" },
      { key: "mod+w", command: "tab.close" },
      "nope",
    ]);
    const parsed = parseKeybindingsFile(text);
    if (!parsed.ok) throw new Error("parse");
    expect(parsed.rules.map((r) => r.key)).toEqual(["mod+shift+p", "mod+banana", "mod+j", "mod+w"]);
    expect(parsed.issues).toEqual([
      { index: 1, problem: "shape" },
      { index: 2, problem: "key" },
      { index: 3, problem: "when" },
      { index: 4, problem: "reserved" },
      { index: 5, problem: "shape" },
    ]);
  });
  it("refuses what it cannot read", () => {
    expect(parseKeybindingsFile("x".repeat(MAX_KEYBINDINGS_FILE_BYTES + 1))).toEqual({ ok: false, error: "too_large" });
    expect(parseKeybindingsFile("{oops")).toEqual({ ok: false, error: "not_json" });
    expect(parseKeybindingsFile('{"key":"a"}')).toEqual({ ok: false, error: "not_array" });
    expect(parseKeybindingsFile(JSON.stringify(Array.from({ length: 257 }, () => ({ key: "mod+k", command: "palette.toggle" }))))).toEqual({ ok: false, error: "too_many" });
  });
  it("exports pretty JSON that reads back the same", () => {
    const rules = [{ key: "alt+p", command: "palette.toggle", when: "!dialogOpen" }];
    const back = parseKeybindingsFile(exportKeybindingsFile(rules));
    expect(back.ok && back.rules).toEqual(rules);
  });
});
```

(Rules whose `key` or `when` do not parse are kept in `rules` — they are the user's text — and reported; `mergeWithDefaults` drops them at use, exactly as Task 16b does.)

`ShortcutsEditor.test.tsx` (`// @vitest-environment happy-dom`, platform `other`):
- the `Open the command palette` row shows `Ctrl` `K` and a `Default` badge; searching `palette` leaves that row only.
- `Change` on that row turns into a pressed recorder reading `Press keys…`; pressing `Ctrl+Shift+P` saves the user rule `{ key: "mod+shift+p", command: "palette.toggle", when: "!panelFocus" }` (store `user`; the default's clause is kept), the row shows `Custom` and `Ctrl` `Shift` `P`; the dispatcher (installed in the test) did not run the palette handler for that keypress.
- in the recorder, `Escape` cancels without a change; `Q` alone says `Include at least one modifier key.`; `Ctrl+W` says `Your browser keeps this shortcut. Choose another.` and saves nothing.
- binding `Ctrl+B` to `Open the command palette` shows `Conflicts with Toggle the session tree` on both rows.
- `Reset` removes the user rules of that command (back to `Default`); `Remove` writes `{ key: "none", command }` and the row reads `Not assigned`.
- the JSON view (`Edit as JSON`) shows the user rules; applying text with a bad entry lists `Entry 2: unknown command.` and applies the valid entries; `Export` produces a file with the user rules; the save status line follows the store (`Saving…` / `Saved to your account` / the error text).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/commands/editor`
Expected: FAIL.

- [ ] **Step 3: Implement**

`keybindings-io.ts`: size check (`TextEncoder`), `JSON.parse` in `try`, `Array.isArray`, length ≤ 256, then per entry `KeybindingRule.safeParse` (failure → `shape`), then for kept entries: command not in `KNOWN_COMMANDS` → reported as `command` and dropped (an unknown command can never run; keeping it would only hide the error), `parseChord` null (and key not `none`) → `key` (kept), `parseWhen` error → `when` (kept), `isReserved` → `reserved` (kept). `exportKeybindingsFile` → `JSON.stringify(rules, null, 2) + "\n"`. (In the test, entry 1's `rm -rf` fails the shape regex of `KeybindingRule.command`, hence `shape`; a well-formed but unknown id such as `nope.nothing` is `command`.)

`ShortcutRecorder.tsx`: `<button type="button" data-shortcut-recorder aria-pressed={recording}>`; while recording, `onKeyDown` calls `preventDefault` and `stopPropagation` on everything; Escape cancels; a lone modifier does nothing; otherwise `chordFromEvent` → `recordedChordProblem` → error text or `onRecord(chord)`. Blur cancels.

`ShortcutsEditor.tsx`: search `TextField`; groups by `COMMANDS[].group` (`commands.group.*` headings); rows (`ShortcutRow`): title, the effective chord tokens (`Kbd`), the badge (`Default` / `Custom`, `Chip tone="mut"` / `"run"`), warnings from `conflictsOf` (`commands.editor.conflict`, "Conflicts with {commands}" — the command titles joined by the locale's list format via `Intl.ListFormat`, no hand-made concatenation) and `isReserved`, then `Change`, `Reset` (shown for custom rows), `Remove`. Writes go through `useKeybindingsStore.getState().setUser(next)` (new `user` array: the recorded rule replaces the user rules of that command and carries the `when` of the command's first default rule, if any). `KeybindingsJson.tsx`: a `Collapsible` "Edit as JSON" with a mono `TextField multiline` holding `exportKeybindingsFile(user)`, `Apply` (parse → `setUser(rules)` + issue list `commands.editor.issue.<problem>` with `{ index: index + 1 }`), `Import` (file ≤ 64 KiB, same path), `Export` (blob download as in Task 26).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm test:unit scripts/literal-coverage.test.ts scripts/class-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(commands): keyboard shortcuts editor with recorder, conflicts and JSON view"
```

---
# Phase 8 — Gallery, budgets, docs

### Task 28: `/dev/ui` gallery — every component, three themes, three densities

DESIGN.md §9.2: "Every component is shown in /dev/ui in all three themes and three densities. The page returns 404 in production and sits behind auth." The gallery is a dev-only pane behind the auth gate (`/dev/ui` exists only when `import.meta.env.DEV`); production builds do not contain it, and `/dev/ui` there shows the not-found screen (the SPA fallback answers 200, so ADR 0011 records the deviation from "404", owner M3-Q5). Themes and densities are applied to the gallery's own frames: every token selector is an attribute selector (Task 1a), so `[data-theme]`/`[data-density]` on a wrapper re-themes its subtree (`@theme inline`, M3R6). The standalone, test-only gallery build that the screenshots needed is deferred with them (owner C1). The gallery's test doubles as the headless touch-target probe: every interactive element it renders carries a 44-px coarse-pointer class (DESIGN §5), checked as classes since no browser measures layout in M3.

**Files:**
- Create: `apps/web/src/gallery/Gallery.tsx`, `GalleryFrame.tsx`, `sections/BrandSection.tsx`, `sections/PrimitivesSection.tsx`, `sections/AiSection.tsx`, `fixtures.ts`, `Gallery.test.tsx`
- Create: `docs/adr/0011-dev-ui-not-shipped.md`
- Modify: `apps/web/src/routes/shell/pane-renderers.tsx` (`dev-ui`), `eslint.config.js` (element `web-gallery`), `catalog/gallery.ts`

**Interfaces:**
- Consumes: every export of `@pap/ui`; `useT`.
- Produces:
  - `Gallery()` — controls (theme `Segmented` night/day/hc, density `Segmented` compact/comfortable/mixed, an "all nine" switch), initial values from `?theme=&density=&all=` (unknown values fall back to night/compact); each section is `<section data-gallery-section="brand|primitives|ai">`, each component instance is wrapped in `<figure data-gallery-item="<ExportName>">` with a caption.
  - `GalleryFrame({ theme: ThemeName; density: Density; children })` → `<div data-slot="gallery-frame" data-theme data-density className="bg-grid text-fg …">`.
  - Boundary element `web-gallery` (`apps/web/src/gallery`): may import `ui`, `web-i18n`, `web-gallery`; `web-routes` may import it.

**Rulings (pre-dispatch):**
- `/dev/ui` in production is the SPA's not-found screen (HTTP 200), recorded in ADR 0011; no daemon route (owner M3-Q5). [M3R122]
- Overlays (dialogs, sheets, menus, toasts, tooltips) are opened from buttons in the gallery; with no screenshots in M3 that is only how they are shown. [M3R123]
- The standalone gallery build (`gallery.html`, `vite.gallery.config.ts`, `src/gallery/main.tsx`, `build:gallery`, `dist-gallery/`) is deferred with the visual regression it served (owner C1); whoever adds it applies M3-RT-33 (no `csp-safe-zod` import in the gallery entry; the config in a tsconfig `include`). [M3R124]
- DESIGN §5's 44 × 44 px rule is checked headless as classes: every interactive element the gallery renders (or its parent or grandparent) carries `pointer-coarse:size-11`, `pointer-coarse:min-h-11` or `pointer-coarse:h-11`; hidden elements (`aria-hidden="true"` or inside one, `hidden`) and links inside rendered markdown prose (WCAG 2.5.8's inline exception) are skipped. It proves the classes are present, not the computed size: the measured probe returns with the deferred browser work. [M3R125]

- [ ] **Step 1: Write the failing tests**

`Gallery.test.tsx` (`// @vitest-environment happy-dom`):

```tsx
import * as ui from "@pap/ui";
import { describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { Gallery } from "./Gallery.tsx";

// Exports that are not components to show: providers, hooks, helpers, constants and types erase at runtime.
const NOT_SHOWN = new Set(["TooltipProvider", "Toaster"]);
const components = Object.entries(ui)
  .filter(([name, value]) => typeof value === "function" && /^[A-Z]/.test(name) && !name.startsWith("Icon") && !NOT_SHOWN.has(name))
  .map(([name]) => name);

const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"], [role="combobox"], [role="menuitem"]';
const COARSE_TARGET = /(?:^|\s)pointer-coarse:(?:size-11|min-h-11|h-11)(?:\s|$)/;

describe("/dev/ui gallery", () => {
  it("shows every component @pap/ui exports", async () => {
    const page = await mount(<Gallery />);
    const shown = new Set([...page.container.querySelectorAll("[data-gallery-item]")].map((el) => el.getAttribute("data-gallery-item")));
    expect(components.filter((name) => !shown.has(name))).toEqual([]);
    await page.unmount();
  });

  it("starts from the theme and density of the address, and falls back on unknown ones", async () => {
    window.history.replaceState(null, "", "/dev/ui?theme=hc&density=comfortable");
    const page = await mount(<Gallery />);
    const frame = page.container.querySelector('[data-slot="gallery-frame"]');
    expect([frame?.getAttribute("data-theme"), frame?.getAttribute("data-density")]).toEqual(["hc", "comfortable"]);
    await page.unmount();
    window.history.replaceState(null, "", "/dev/ui?theme=sepia&density=huge");
    const fallback = await mount(<Gallery />);
    expect(fallback.container.querySelector('[data-slot="gallery-frame"]')?.getAttribute("data-theme")).toBe("night");
    await fallback.unmount();
  });

  it("renders nine frames when asked for all", async () => {
    window.history.replaceState(null, "", "/dev/ui?all=1");
    const page = await mount(<Gallery />);
    expect(page.container.querySelectorAll('[data-slot="gallery-frame"]')).toHaveLength(9);
    await page.unmount();
  });

  it("gives every interactive element a 44-px coarse-pointer class (DESIGN §5, classes only)", async () => {
    window.history.replaceState(null, "", "/dev/ui");
    const page = await mount(<Gallery />);
    const bare = [...page.container.querySelectorAll(INTERACTIVE)]
      .filter((el) => !el.closest('[aria-hidden="true"], [hidden]'))
      // Links inside running text are exempt (WCAG 2.5.8's inline exception): a prose link cannot be 44 px tall.
      .filter((el) => !el.closest("[data-markdown-body]"))
      .filter((el) => ![el, el.parentElement, el.parentElement?.parentElement].some((node) => node && COARSE_TARGET.test(node.getAttribute("class") ?? "")))
      .map((el) => `${el.closest("[data-gallery-item]")?.getAttribute("data-gallery-item") ?? "?"}: <${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent?.slice(0, 20) ?? ""}>`);
    expect(bare).toEqual([]);
    await page.unmount();
  });
});
```

(Components that need a provider render inside the gallery's own `TooltipProvider`; `Dialog`, `Menu`, `toast` show as buttons that open them, wrapped in their `data-gallery-item` figure. If the probe names an element, fix the component's classes, never the probe.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/gallery`
Expected: FAIL.

- [ ] **Step 3: Implement**

Sections show, with sample content from `fixtures.ts` (data, exempt from the literal gate): Brand (`Mark` 16/24/48 and `mode="day"`, `Wordmark` with tagline); Primitives (`Button` × 4 variants × 2 sizes + disabled, a `Spinner`, `IconButton` ghost/secondary with a badge, `Tooltip` trigger, `Kbd`, `TextField` with hint and error, `Select`, `Switch`, `Checkbox`, `Slider`, `Segmented`, `Chip` × 6 tones, `Badge` 3 / 120, `Avatar` × 3 styles × presence, `Meter` tokens/cost, `ProgressBar` determinate/indeterminate, `Banner` × 4, `EmptyState`, `OpenTab` active/idle/running, `Collapsible`, buttons opening `Dialog` (center, sheet, drawer-left, drawer-right, palette), `Menu`, and a `toast` with Undo); AI (`Message` you/agent/tool with meta and actions, an agent `Message` whose body is `Markdown` with a list, a link and a fenced TypeScript block, `MessageBranch`, `AuthorGroup`, `DaySeparator`, `RunStatusChip` × 5, `Fence`, `Reasoning` streaming and settled, `ToolCard` × 3 details + running + error, `ApprovalCard` with the M1 props and with `answers` (all four, taint and context)). Every visible chrome string goes through `useT` (`gallery.*` keys); sample content does not.

`pane-renderers.tsx`: `"dev-ui": () => (DevGallery ? <Suspense fallback={null}><DevGallery /></Suspense> : <NotFound />)` with `const DevGallery = import.meta.env.DEV ? lazy(() => import("../../gallery/Gallery.tsx").then((m) => ({ default: () => <m.Gallery /> }))) : null;` (dev only, never shipped: Task 32 proves the production build holds none of it; a dev chunk needs no `LazyBoundary`).

`docs/adr/0011-dev-ui-not-shipped.md`:

```markdown
# ADR 0011 — /dev/ui is not shipped; unknown routes show the not-found screen

Status: accepted · Date: 2026-10-11 · Spec: DESIGN.md §9.2 ("The page returns 404 in production and sits behind auth") · Owner decision: M3-Q5

## Context
The daemon answers every navigation outside the reserved prefixes with index.html (R78): the SPA, not the server, decides what a
path shows. A literal HTTP 404 for /dev/ui would need a daemon route for a page that only exists in development.

## Decision
The gallery code is compiled only when `import.meta.env.DEV` is true. In a production build, /dev/ui is an unknown path: the app
shows its not-found screen (HTTP 200 from the SPA fallback). In development the gallery is a pane behind the auth gate. M3 has no
standalone gallery build: visual regression, which needed one, is deferred with the browser e2e (owner decision C1).

## Consequences
Nothing of the gallery reaches users; the build-output test checks it. If the owner wants a real 404, the daemon gains one reserved
path; nothing in the web app changes.
```

`eslint.config.js`: element `{ type: "web-gallery", pattern: "apps/web/src/gallery" }`, rule `{ from: "web-gallery", allow: ["web-gallery", "ui", "web-i18n"] }`, and `"web-gallery"` added to `web-routes`' allow list.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm knip && pnpm test:int apps/web/src/build-output.int.test.ts`
Expected: PASS. Mutation check: remove `pointer-coarse:min-h-11` from `Segmented`'s items once → the touch-target case names them.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web eslint.config.js docs/adr/0011-dev-ui-not-shipped.md
git commit -m "feat(ui): /dev/ui gallery of every component in three themes and densities, with a touch-target probe"
```

---

### Former Tasks 29–31: removed (owner C1, 2026-10-11)

The Playwright container runner (former Task 29), the owner / shell / phone journeys and the CI `e2e` job (former Task 30), and the visual regression of the gallery with the PNG icons (former Task 31) are not part of M3. They are deferred like decision 36 moved the M1 journey: "pas de e2e pour l'instant" (owner M3-Q10, then C1). Consequences, decided:

- `scripts/ci-config.test.ts` stays as it is (no `e2e` script, no Playwright, the exact CI job list); M3 adds no `@playwright/test`, no `playwright.config.ts`, no `e2e/` folder, no `scripts/e2e.ts`. M3-RT-17, -18, -34 and -35 are moot for M3 and are carried in "What this plan explicitly defers" for whoever revives the work; M3-RT-33 likewise (the standalone gallery build is deferred).
- What moved to headless checks: "no native `title`" (ESLint `pap/no-native-title`, Task 2), "no unknown classes / no literal text / React Compiler" (Tasks 2, 3), the CSP-relevant build facts (build-output test: no inline script, boot script first, fonts as files, no WebAssembly, lazy chunks, no gallery in production: Tasks 1b, 10b, 11, 14, 24, 25, 32), the 44-px targets as classes (Task 28's probe), keyboard and shell behaviour (happy-dom tests of Tasks 16a–23).
- What is deferred and not replaced: zero CSP violations and zero console errors observed in a real browser, measured target sizes, WebKit rendering, the passkey ceremony in a browser, the Safari 16.4 WebSocket CSP check (R118), gallery screenshots (R129's DESIGN §14 item) and the PNG icons (with M12's manifest).
- P6 is the bundle re-measure only (agreement 11).

---

### Task 32: Bundle budget from real numbers, docs, final gates

Roadmap M3 exit: "the bundle budget is re-set from real numbers". Spec C §7.4: editor, terminal, diff and shiki load lazily; in M3 the palette (cmdk), the Settings screen, the shortcuts help, the theme editor, the markdown renderer and the highlighter stay out of the initial assets, which the build-output test proves. Owner R3-5 / agreement 10: target ≤ 200 KB gzip for the initial assets.

**Files:**
- Modify: `budgets.json`, `scripts/check-budgets.ts` (prints the lazy chunks too), `scripts/check-budgets.test.ts`, `apps/web/src/build-output.int.test.ts`
- Create: `docs/agents/web.md`
- Modify: `AGENTS.md` (topic note link)

**Interfaces:**
- Produces: `lazyAssets(distDir: string): Array<{ file: string; gzipKb: number }>` (every `/assets/*.js|css` not in the initial list); the final `initialBundleGzipKb` value.

**Rulings (pre-dispatch):**
- The final budget is the measured initial gzip size × 1.10, rounded up to the next KB, when that is at most 200 KB; above 200 KB the controller stops and asks the owner before committing any value (owner R3-5, agreement 10). A provisional value set mid-milestone is replaced here. [M3R126]
- `docs/agents/web.md` (≤ 120 lines) describes what the code does, including the deferred browser checks as deferred, never as done. [M3R127]
- AGENTS.md gains no e2e command (owner C1); it gains the topic note link only and stays under 150 lines. [M3R128]

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/build-output.int.test.ts`:

```ts
  it("ships no gallery in the production build (ADR 0011)", async () => {
    for (const name of assets) expect(await readFile(join(out, "assets", name), "utf8"), name).not.toContain("data-gallery-section");
  });

  it("keeps the palette (cmdk) out of the initial assets", async () => {
    const initial = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1] ?? "");
    for (const name of initial) expect(await readFile(join(out, "assets", name), "utf8"), name).not.toContain("cmdk-input");
    const all = await Promise.all(assets.filter((name) => name.endsWith(".js")).map((name) => readFile(join(out, "assets", name), "utf8")));
    expect(all.some((code) => code.includes("cmdk-input"))).toBe(true);
  });
```

Add to `scripts/check-budgets.test.ts` a case for `lazyAssets` on the existing fixture: it returns exactly `[{ file: "/assets/lazy-d4.js", gzipKb: <the gzip size of 500 000 "x", rounded to 0.1> }]` (compute the expected value in the test with `gzipSync`).

- [ ] **Step 2: Run them to see them fail, then implement**

Run: `pnpm test:int apps/web/src/build-output.int.test.ts && pnpm test:unit scripts/check-budgets.test.ts`
Expected: the gallery and lazy-palette cases pass already if Tasks 22 and 28 did their part (keep them as gates); `lazyAssets` fails until written. Implement `lazyAssets` next to `initialAssets` and print each lazy chunk in the main block (`lazy <file>: <n> KB gzip`).

- [ ] **Step 3: Measure and set the budget**

Run: `pnpm build && pnpm budgets`
Record the printed `initial bundle: <measured> KB gzip` and the lazy chunks. If `ceil(measured × 1.10)` is at most 200, set `budgets.json` `initialBundleGzipKb` to it and run `pnpm budgets` again: exit 0. If it is above 200, stop: report the number and the largest initial modules to the controller, who asks the owner; nothing is committed until the owner answers.

- [ ] **Step 4: Write the topic note and the AGENTS.md line**

`docs/agents/web.md` (≤ 120 lines, what the code does, no claims beyond it): the shell (the URL names the active item; `PANE_RENDERERS`; only the active tab is mounted; the workspace in `pap.workspace.v1`; lazy chunks through `lib/lazy.tsx`), appearance (two scopes; the account documents and their compare-and-set sync — hold until loaded, merge and one retry on conflict, R105; the boot cache, its variable allowlist and why the boot script is an external hashed file; ADR 0012's tokens; the theme-selector rule and why `@theme inline`; the derivation ratios of §13.2), commands (registry, the dispatcher's bail-outs, `when` keys including `panelFocus`/`overlayOpen`/`treeOpen`, physical-key recording, reserved chords, where defaults live), i18n (`useT` vs `t`, namespace catalogs, the literal gate and its allowlist, `serverText` until P4), markdown (react-markdown without raw HTML, safe links, no images, shiki's JavaScript engine and the code colours), the gates (class coverage and where class lists may live, the compiler gate, `pap/no-native-title`, the touch-target class probe), what is deferred (browser e2e, screenshots, PNG icons, the R118 Safari check), the measured bundle numbers, and the traps (Safari 16.4: no CSS nesting, no RegExp `v` flag, `:has()` allowed; IME keyCode 229; AltGr; no native `title`; tokens through utilities only).

`AGENTS.md`: under topic notes add `docs/agents/web.md`. AGENTS.md stays under 150 lines.

- [ ] **Step 5: Run every gate (the M3 exit)**

Run:
```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm smoke && pnpm budgets
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add budgets.json scripts/check-budgets.ts scripts/check-budgets.test.ts apps/web/src/build-output.int.test.ts docs/agents/web.md AGENTS.md
git commit -m "chore(budgets): re-set the initial bundle budget from the M3 build; web topic note"
```

---
# After both milestones merge — post-merge tasks P1–P7

These need M2's code on `main`. M2 merges first (owner T3, agreement 1); M3 then rebases once (see "Merge order and conflict notes": conflicts, migration re-stamp, lockfile) and runs P1–P7 on its own branch before its PR, so `main` never carries the token aliases or an unadopted shell. If the order ever flips, the same tasks run on a follow-up branch right after M2 merges. Each is a normal task (failing test first, gates, Conventional Commit, the lessons checklist). Order (agreement 14, M3-RT-21): **P7 → P3 → P2 → P1 → P4 → P5 → P6** — the gates first, because their findings feed P1–P3; P3 and P2 before P1, because they rewrite the files P1 would otherwise migrate twice; P6 last, because it measures the final code. Models: Sonnet implementer, Sonnet reviewer for all seven.

| # | Task | Files (expected) | Test that proves it |
|---|---|---|---|
| P7 | Run M3's gates over M2's files and fix what they find: delete the `M2_OWNED_UNTIL_P7` exclusion of `scripts/class-coverage.ts` and the `features/sessions` alternative of `scripts/literal-coverage.ts`'s `SKIPPED`; fix the class, literal, React Compiler and `pap/no-native-title` findings in M2's files; add to `IDENTICAL_IN_FR` any M2 key whose French equals the English, with a reason (agreement 4 expects none) | `scripts/class-coverage.ts` (+ test), `scripts/literal-coverage.ts`, `apps/web/src/features/sessions/**`, `apps/web/src/i18n/i18n.test.ts`, `scripts/literal-allowlist.json` only with a reason | the four gates pass over the whole repository; the "leaves M2's session screens to P7" case is replaced by "scans M2's session screens" |
| P3 | The session screen in the shell: M2's screens use `<section>` and `AppShell` owns `<main>`; `max-w-chat` on the transcript; `AuthorGroup`, `Reasoning`, message actions; `ToolCard` replaces M2's `ToolRow` (detail from the account's `toolDetail`); agent text renders through `Markdown` (`onLoadError` → `reportClientIssue("lazy_chunk_failed")`); M2's `ApprovalDialog` becomes `ApprovalCard` with `answers` + `labels` + `onChoose` (agreement 6); `useT` instead of `t` in `features/sessions`; `useCommand("session.stop")` for Escape and `useCommand("session.sendOther")` for "send with the other streaming behaviour" (default chord `mod+shift+enter`, `when: "sessionFocus && !panelFocus"`, added to `COMMANDS` and `DEFAULT_KEYBINDINGS`); M2's `CustomPanel` (and any terminal-input surface) carries `data-terminal-input` (agreement 7); polite live regions announce a run's end and a new approval (DESIGN §12) if M2's screen has none; M2's test helper `show()` wraps `TooltipProvider` once message actions render; the reconnect banner adds "your drafts stay on this device" (M2's drafts exist then) | `apps/web/src/features/sessions/**`, `routes/shell/AppShell.tsx`, `MobileShell.tsx`, `ConnectionBanner.tsx`, `features/commands/defaults.ts`, `apps/web/src/approval-answer.test.ts` | a shell test: one `main` landmark on `/s/:id`; Escape in a running session stops it, and does not when focus is in the custom panel or a menu is open (dispatcher + handler); `mod+shift+enter` sends with the other behaviour; a locale switch re-renders the transcript's labels; `approval-answer.test.ts` asserts `ApprovalAnswer` of `@pap/ui` and of `@pap/contracts` are the same type (both directions assignable); M2's integration tests stay green |
| P2 | Promote M2's feature components into `packages/ui` (DESIGN §9.2): the select / text / confirm dialog shells as `InputRequestCard`, `StatusBar`, `Widgets`, `CustomPanel`, with gallery entries; M2's call sites switch to them. `QueueStrip` and `Minimap` stay feature components (agreement 14); `ToolRow` is already gone (P3) | `packages/ui/src/ai/*`, `apps/web/src/features/sessions/**`, `apps/web/src/gallery/sections/AiSection.tsx` | the gallery's "shows every component" and touch-target probe pick them up; their own unit tests move with them; M2's integration tests stay green |
| P1 | Remove the M1 token aliases: migrate every `bg-panel`, `border-line`, `*-human*`, `text-on-fill`, `*-attention*`, `text-error`, `border-error` in M2's files (tests included: `grep -rE 'bg-panel\|border-line\|human\|on-fill\|attention\|border-error\|text-error' apps/web/src/features/sessions`) to the DESIGN names, then delete the alias block of `tokens.css`; drop `ApprovalCard`'s M1 props once no caller uses them (`cn`, `once`, `FOCUS_RING` stay) | `apps/web/src/features/sessions/**`, `packages/ui/src/tokens.css`, `tokens.test.ts`, `packages/ui/src/ai/ApprovalCard.tsx` | `tokens.test.ts` "keeps the M1 utility names" becomes "the M1 aliases are gone"; class coverage passes over the whole web app |
| P4 | Server texts by code (R128): `notice` events and `status` causes carry a stable `code` (+ params) next to the English text; the reducer shows `serverText` by code; the pattern matching of Task 3 stays only as a fallback for an older daemon | `packages/contracts/src/streams.ts`, the M2 files that emit notices and causes (at planning time `apps/daemon/src/modules/sessions/{live-run,live-ui,notices}.ts`; check on `main`), `apps/daemon/src/kernel/supervisor/exit.ts`, M2's split reducer (at planning time `apps/web/src/stores/{reduce-pi,row-view}.ts`), `apps/web/src/i18n/server-text.ts` | contract test for the new fields; reducer test: a French session shows the French notice for a coded event |
| P5 | R129's reducer items: first check whether M2's entry-id rows already resolved them (then close with a test only); otherwise linear snapshot reduce (a running `Map`, not a `Set` per message) and no content dedup for `role:none` fallback refs | M2's split reducer files (+ tests) | a 2 000-message snapshot reduces in linear steps (count the key lookups through an injected map); two different `role:none` messages with equal content both stay |
| P6 | Re-measure the bundle on the merged code and set `budgets.json` by Task 32's rule (≤ 200 KB gzip: measured × 1.10; above: the owner decides). Bundle only: the browser suite is deferred (owner C1, agreement 11) | `budgets.json` | `pnpm build && pnpm budgets` green on the merged code |

**Rulings (pre-dispatch), P1–P7:**
- P7 runs first and removes both scan exclusions; its findings in M2's files are fixed there, never allowlisted without a written reason. [M3R129]
- P3 adopts the converged ApprovalCard API, `ToolCard` for `ToolRow`, `Markdown` for agent text, the panel/overlay keys (`data-terminal-input` on M2's panel), the polite live regions, the `session.sendOther` binding (`mod+shift+enter`) and the drafts line; it adds the type-level `ApprovalAnswer` test. [M3R130]
- P2 promotes exactly the four DESIGN §9.2 components; `QueueStrip` and `Minimap` stay in M2's feature folder; gallery entries, no screenshots (deferred). [M3R131]
- P1 runs after P3 and P2 and greps M2's tests for the M1 class names first; it removes the M1 ApprovalCard props only when no caller remains. [M3R132]
- P4 targets M2's split files as they are on `main` (the names above are M2's plan at the time of writing) and keeps the pattern fallback for an older daemon. [M3R133]
- P5 checks first whether M2's entry-id rows already resolved R129's items. [M3R134]
- P6 is the bundle re-measure only (agreement 11); above 200 KB gzip the owner decides before anything is committed. [M3R135]

ETA for P1–P7: about 11–13 hours including reviews (red-team estimate 12–15 h, minus the e2e re-run P6 no longer holds).

# Model table

Owner's cost rules: Haiku for mechanical transcription, Sonnet by default, Opus reviewer only for security-critical or concurrency-heavy tasks, Opus for the final whole-branch review. This table is the owner-approved one (X2): Haiku implementers for Tasks 4, 7 and 11; Opus reviewers for Tasks 12, 14 and 15. A task still failing after three fix rounds may go to an Opus implementer for rounds 4–5 (owner T1). Any other upgrade needs the owner's approval first.

| Task | Implementer | Reviewer | Why |
|---|---|---|---|
| 1a Tokens and ADR 0012 | Sonnet | Sonnet | transcription plus the R120 amendment and its contrast tests |
| 1b Fonts, stylesheet, compile tests | Sonnet | Sonnet | Tailwind 4 subtleties (named spacing, `@utility`, variants) |
| 2 Design-system gates | Sonnet | Sonnet | AST extraction and the compiler API |
| 3 i18n structure | Sonnet | Sonnet | |
| 4 Icons, feedback, formats | **Haiku** | Sonnet | code fully prescribed (lucide only in `@pap/ui`, M3-RT-25) |
| 5 Button, tooltip, kbd | Sonnet | Sonnet | |
| 6 Form controls | Sonnet | Sonnet | Radix wiring |
| 7 Status and structure | **Haiku** | Sonnet | code fully prescribed, one pattern repeated (ADR 0010, M3-RT-23) |
| 8 Overlays | Sonnet | Sonnet | focus return, sheets, toast store |
| 9 Message and conversation | Sonnet | Sonnet | |
| 10 Reasoning, ToolCard, ApprovalCard | Sonnet | Sonnet | the converged answer API (agreement 6) |
| 10b Markdown and highlighting | Sonnet | Sonnet | library APIs to verify; the safety rules are pinned by tests |
| 11 Logo | **Haiku** | Sonnet | exact geometry given |
| 12 Settings module | Sonnet | **Opus** | new permission domain, per-owner documents with compare-and-set, composed into the daemon inside M2's area |
| 13 Appearance model | Sonnet | Sonnet | pure functions |
| 14 Boot script and applier | Sonnet | **Opus** | runs before the app under the strict CSP (R74) and turns untrusted `localStorage` into attributes and style properties |
| 15 Appearance store and sync | Sonnet | **Opus** | persisted user data, lost updates, async ordering (M3-RT-01) |
| 16a Chords and labels | Sonnet | Sonnet | |
| 16b `when`, defaults, merge | Sonnet | Sonnet | |
| 17a Registry and dispatcher | Sonnet | Sonnet | |
| 17b Keybindings and help | Sonnet | Sonnet | reuses Task 15's engine |
| 18 Workspace model | Sonnet | Sonnet | |
| 19a Router and shell skeleton | Sonnet | Sonnet | |
| 19b Rail, top bar, shell effects | Sonnet | Sonnet | |
| 20 Tabs and split | Sonnet | Sonnet | |
| 21 Drawers, commands, lazy boundary | Sonnet | Sonnet | |
| 22 Palette | Sonnet | Sonnet | |
| 23 Phone shell | Sonnet | Sonnet | |
| 24 Settings screen | Sonnet | Sonnet | |
| 25 Appearance panel | Sonnet | Sonnet | |
| 26 Theme editor | Sonnet | Sonnet | imports untrusted JSON, but through the contracts schema of Task 12 |
| 27 Shortcuts editor | Sonnet | Sonnet | |
| 28 Gallery | Sonnet | Sonnet | |
| 32 Budgets and docs | Sonnet | Sonnet | the topic note must describe the whole milestone accurately |
| Final whole-branch review | — | **Opus** | owner rule |
| P1–P7 | Sonnet | Sonnet | |

Summary: 34 tasks (Tasks 1–28 and 32, with 1, 16, 17 and 19 split, 10b new, 29–31 removed) — 3 Haiku and 31 Sonnet implementers; reviewers are Sonnet except Tasks 12, 14 and 15 (Opus) and the final review (Opus); then 7 post-merge tasks, Sonnet / Sonnet.

# ETA

Observed in M1: about 1–1.5 h per task including review and fix rounds, security tasks longer; M1 needed at least one fix round per task, and the red-team found prescribed-code defects this revision fixes. Here: 34 tasks × ~1.25 h ≈ 42.5 h; the three Opus reviews +1.5 h; the compare-and-set design in Tasks 12, 15 and 17b +2 h; final review and its fixes +3 h. **≈ 49 h of agent time (range 44–55 h)**: the red-team's 55 h, minus the five e2e tasks and their container wiring (≈ 9 h), plus Task 10b (≈ 2 h with its library checks) and the R120 amendment (≈ 0.5 h). Then P1–P7, about 11–13 h after M2 merges. Pipelined with M2 (reviews of one overlapping implementation of the other), the calendar time is set by the slower milestone rather than the sum.

# Owner decisions (2026-10-11)

Source: `.superpowers/owner-decisions-2026-10-11.md` (pages 1 and 2). M2's plan fix records them in `docs/research/decisions-log.md` (agreement 12); this plan does not touch that file.

| Question | Decision | Where |
|---|---|---|
| M3-Q1 R120 contrast | (b) amend through ADR 0012: day focus ring `#EA580C`; `--control-border` day `#8F877A`, night `#6B6485`; night approval title `#F472B6`; `--attn-ink` `#110F18` on pink fills (night, high contrast) | 1a, 13 |
| M3-Q2 theme mode × presets | confirmed: mode picks the side, each side has its theme; high contrast is a dark theme | 13, 25 |
| M3-Q3 keybindings scope | per account, on the server (`settings` module) | 12, 17b |
| M3-Q4 default chords | confirmed | 16b |
| M3-Q5 `/dev/ui` in production | SPA not-found (HTTP 200), ADR 0011 | 28 |
| M3-Q6 visual regression | Chromium only — moot for M3 (visual regression deferred, C1) | deferred |
| M3-Q7 first-run stepper | deferred to M7 | 24 |
| M3-Q8 fonts | bundled Manrope + JetBrains Mono, or the system stacks | 25 |
| M3-Q9 small visual calls | all confirmed (HUD-size button labels, 60 % dim, bounded spinner, 16 px touch inputs) | 5, 8, 4, 6 |
| M3-Q10 / C1 browser e2e | none for now: Tasks 29–31 removed and deferred; exit criteria headless; M1's `ci-config.test.ts` guards unchanged; P6 = bundle re-measure | Phase 8, P6 |
| R3-1 markdown | new Task 10b: lazy markdown + shiki's JavaScript regex engine, CSP unchanged; tool renderers to M6 (DiffView) | 10b |
| R3-2 reset | keeps the custom theme library | 15, 25 |
| R3-3 language | per device | 3, 24 |
| R3-4 settings concurrency | compare-and-set (`baseRevision`), field merge, one retry; field-wise parse with `.default()`; Opus reviewer on Task 15 | 12, 13, 15, 17b |
| R3-5 bundle | target ≤ 200 KB gzip; lazy Settings, shortcuts help, theme editor, shortcuts editor; provisional budgets mid-milestone; above 200 → owner | Global Constraints, 21, 22, 24, 26, 32 |
| R3-6 Escape | goes to the panel or menu first, otherwise stops the run (agreement 7) | 16b, 17a, P3 |
| R3-7 layouts | digits and punctuation recorded by physical key | 16a, 27 |
| R3-8 settings module in M2's area | accepted | 12 |
| R3-9 login throttle copy | the copy says what the throttle does | 24 |
| X2 model table | as above | Model table |
| X3 ETA | noted; recomputed above (≈ 49 h, P1–P7 ≈ 11–13 h) | ETA |
| T1 Opus escalation at fix rounds 4–5 | allowed | Plan conventions |
| T3 merge order | M2 then M3 | Merge notes |

# Exit criteria (roadmap M3, headless — owner C1)

Checked without a browser on this host and in CI's existing jobs:
- `pnpm lint` clean, including `pap/no-raw-colors` (only `presets.ts`, `contrast.ts`, `derive.ts` exempt), `pap/no-arbitrary-values`, `pap/no-restyle`, `pap/no-native-title`, `pap/zustand-selector`, boundaries and the 400-line cap (`tokens.css` and `utilities.css` included).
- `scripts/class-coverage.test.ts` (no unknown classes, exact selectors), `scripts/literal-coverage.test.ts` (no literal UI text), `apps/web/src/compiler-gate.test.ts` and `compiler-pipeline.int.test.ts` (React Compiler on `@pap/ui` and the app) green — over everything but M2's `features/sessions`, which P7 adds.
- `packages/ui/src/tokens.test.ts` (themes, densities, selectors, presets, ADR 0012 values and ratios), `scripts/token-classes.test.ts`, i18n tests (every key in fr, reactive switch), Safari 16.4 floor and no native CSS nesting, build-output checks (no inline script, boot script first, fonts as files, no WebAssembly, no gallery in production; palette, Settings, shortcuts help, theme editor and markdown out of the initial assets), `scripts/notices.test.ts` (canonical Apache-2.0 text).
- Account settings: compare-and-set and field-wise parsing pinned by `service.test.ts`, `settings.test.ts`, `account-setting.test.ts`, `controller.test.ts`, `keybindings-store.test.ts`.
- DESIGN §5 touch targets as classes (Task 28's probe); keyboard, shell and phone behaviour in happy-dom (Tasks 16a–23).
- `pnpm typecheck`, `pnpm knip`, `pnpm format:check`, `pnpm test:unit`, `pnpm test:int`, `pnpm build`, `pnpm smoke`; `scripts/ci-config.test.ts` unchanged and green.
- `budgets.json` re-set from the measured M3 build (≤ 200 KB gzip, or the owner's answer); `pnpm budgets` exit 0.

Not checked in M3 (deferred with the browser e2e, owner C1): journeys in Chromium and WebKit, runtime CSP violations and console errors, measured 44 × 44 px targets, gallery screenshots, PNG icons, R118's Safari 16.4 WebSocket check.

# Coverage map

| Requirement (roadmap M3, DESIGN.md, brief) | Task |
|---|---|
| DESIGN §3 tokens: Night, Day · Papier, High contrast; §3.4 geometry; replace the M1 subset; R120 amendment (ADR 0012) | 1a |
| §4 typography, self-hosted fonts in `packages/ui` | 1b |
| §5 densities, 44 px targets | 1a, 5–8 (classes), 28 (class probe); measured: deferred |
| §6 logo and wordmark, SVG favicon | 11; PNG favicons and PWA icons: M12 |
| §7.1 icons, no native title | 4, 2 |
| §7.2 motion, reduced motion | 1a, 4 |
| §7.3 Orca feedback timing | 4, 5 |
| §7.4 focus ring (ADR 0012) | 1a, 1b, 5 |
| §8 shell: rail, top bar, tabs, panes, ⌘B drawer, Inbox drawer (decision 25) | 18–21 |
| §8 breakpoints, phone bottom nav, one pane, sheets (D19) | 8, 23 |
| D19 viewport and mobile keyboard | 23 |
| §9.1 owned Radix primitives (+ Collapsible, ADR 0010) | 4–8 |
| §9.2 AI components per S6 with Apache-2.0 attribution | 9, 10 |
| Markdown and code highlighting in messages (spec C §7, owner R3-1) | 10b |
| §9.2 `/dev/ui` in 3 themes × 3 densities, not in production (ADR 0011) | 28, 32 |
| §11 en + fr everywhere, no concatenation, server texts | 3, every UI task, P4 |
| §12 contrast per role in the theme editor, confirmation below AA | 13, 26 |
| §13 appearance settings per account (compare-and-set) and per device, live, reset (decisions 27–28, owner R3-2, R3-4) | 12, 13, 15, 25 |
| §13.1–13.2 custom themes, JSON import/export, derived tokens | 13, 26 |
| §14 no flash before first paint under the strict CSP | 14 |
| Keybindings JSON with `when` + editor (spec C §7.4) | 12, 16a, 16b, 17a, 17b, 27 |
| Cmd+K palette (cmdk) | 22 |
| Design-system lint clean on every screen | 2, 3 (headless gates); runtime checks deferred |
| Shell works on desktop and phone | 19a–23 (happy-dom); browsers: deferred |
| Bundle budget re-set from real numbers (≤ 200 KB gzip) | 32, P6 |
| Playwright journey dropped from M1 (decision 36, R51) | deferred again (owner C1) |
| R120, R129, R125, R118, R122/R128, IME 229, mono labels, on-fill per role, selector specificity | see "Backlog rulings absorbed" |
| T3 Code and Orca patterns cited per task | 2, 4, 5, 8, 14, 16a–18, 20–23, 26, 27 |

# Execution handoff

Plan saved to `docs/plans/2026-10-11-m3-design-system.md` in the `feat/m3-design` worktree. The method is fixed by the brief (subagent-driven, pipelined with M2). Every owner question is answered (above) and every task's rulings are decided (`.superpowers/rulings-m3.md`, M3R1…); the only open items are the ones a task marks "discovered during implementation", which its implementer reports and the controller rules on then. Dispatch in task order (1a, 1b, 2, 3, …, 10, 10b, 11, …, 28, 32); the post-merge tasks wait for M2's merge and run in the order P7 → P3 → P2 → P1 → P4 → P5 → P6.

# Merge order and conflict notes

The 14 M2 ⇄ M3 cross-plan agreements (`.superpowers/m2-m3-cross-plan-agreements.md`) as they apply to M3:

1. **Merge order: M2 first, then M3** (owner T3). M3 rebases once on a `main` holding M2, resolves the hunks below, runs P1–P7 on its branch and opens its PR with the post-merge work included. **Migrations:** the branch that merges second re-stamps its migrations after the newest stamp on `main` during its rebase (never applied on `main`, so a rename is safe). M3's `apps/daemon/src/modules/settings/migrations/202610111000_settings.sql` already sorts after M2's `202610110000_session_name.sql` and `202610110100_policy.sql`; if M2's final stamps sort later, rename M3's file after the newest one and re-run `pnpm test:int apps/daemon` (`migrate.ts` refuses a migration that sorts before an applied one).
2. **ADR numbers:** M2 0006 (export route), 0007 (hot-session reads), 0008 (protocol records), 0009 (daemon-side fork/clone); M3 0010 (Collapsible), 0011 (`/dev/ui` not shipped), 0012 (R120 contrast amendment).
3. **R125:** parked in both plans' deferrals — stream keying until the first second stream (M4 sessions list or M10 inbox), hidden-tab reconnect throttling in M12; neither milestone adds a second stream.
4. **i18n:** M2's keys all sit in its delimited `sessions (M2)` block; it adds no key whose French equals the English. M3 keeps `IDENTICAL_IN_FR` handling: the rebase re-runs `i18n.test.ts`, P7 adds any identical M2 key with a reason.
5. **`@pap/ui` must-keep API until P1:** `Button`, `TextField`, `Message`, `ApprovalCard` (M1 props), `cn`, `FOCUS_RING`, `once`, and the M1 token utility classes M2 lists. Task 5 updates `SessionScreen.test.tsx`'s two class assertions; at the rebase take M2's version and re-apply the class names (`bg-surface`, `border-err`) wherever its assertions survive.
6. **ApprovalCard convergence:** `answers` + `labels` + `onChoose(answer)`, M1 props as a thin adapter, answer names `deny | once | session | always`, header sentence case in the DOM and uppercase in CSS (M2's ApprovalDialog does the same). P3 replaces M2's ApprovalDialog and adds the type-level `ApprovalAnswer` test.
7. **Escape and keys in panels:** M2's CustomPanel carries `data-terminal-input` and stops propagation of the keys it consumes; M3's dispatcher has `panelFocus` and `overlayOpen`; every default chord has `!panelFocus`, Escape also `!overlayOpen` (Tasks 16b, 17a; P3 verifies on M2's screen).
8. **Shared files** (resolution below).
9. **Markdown and code highlighting:** M3's Task 10b (lazy, shiki's JavaScript engine, CSP unchanged); tool renderers to M6 on DiffView; M2 renders plain text with `<details>` until P3.
10. **Bundle:** ≤ 200 KB gzip target; lazy Settings, shortcuts help, theme editor, shortcuts editor; provisional `budgets.json` values mid-milestone with a commit note, never a test edit; above 200 KB the owner decides. M2's Task 30 follows the same rule.
11. **e2e dropped:** M3's former Tasks 29–31 removed and deferred; `scripts/ci-config.test.ts` guards unchanged; P6 is the bundle re-measure only.
12. **decisions-log:** only M2's plan fix appends to `docs/research/decisions-log.md`; M3 does not touch it.
13. **Coordination-contract exception:** M3's `settings` module, contracts file and permission domain in M2's areas are accepted (Opus-reviewed, one-line hunks).
14. **Post-merge order:** P7 → P3 → P2 → P1 → P4 → P5 → P6, with the items listed in the P-task table.

| File | M2 (expected) | M3 | Resolution on rebase |
|---|---|---|---|
| `packages/contracts/src/methods.ts` | many new `sessions.*` methods appended | `import { settingsMethods }` + `...settingsMethods,` as the catalogue's first entry | keep both; M3's two lines sit at the top, M2's entries at the bottom |
| `packages/contracts/src/methods.test.ts` | new mutations in the sorted list | `"settings.set"` in the sorted list | union, kept sorted |
| `packages/contracts/src/permissions.ts` | `"policy"` domain | `"settings"` | union of `DOMAINS` |
| `packages/contracts/src/index.ts` | `export * from "./policy.ts"` and others | `export * from "./settings.ts";` | union |
| `apps/daemon/src/daemon.ts` | policy module, idle release, scopes, new deps | settings module import, `SETTINGS_MIGRATIONS` in `sources`, `...settings.rpc` | keep both (the `handlers` and `sources` lines touch the same statements); re-run `pnpm test:int apps/daemon/src/daemon.settings.int.test.ts` (M2 may change the harness) |
| `apps/daemon/src/modules/*/migrations` | `202610110000_session_name.sql`, `202610110100_policy.sql` (+ any later) | `settings/migrations/202610111000_settings.sql` | agreement 1: re-stamp M3's file after M2's newest stamp if it no longer sorts last |
| `apps/web/src/i18n/en.ts`, `fr.ts` | the delimited `sessions (M2)` block | four imports at the top and four spreads first in the object | keep both; the `fr` type annotation catches a missing key |
| `apps/web/src/i18n/i18n.test.ts` | its own keys / cases | reactive-locale cases, `IDENTICAL_IN_FR` in "translates every key into French" | union of cases; keep M3's `IDENTICAL_IN_FR` logic; re-run |
| `apps/web/src/features/sessions/SessionScreen.test.tsx` | rewritten | two class assertions (Task 5) | take M2's version, re-apply `bg-surface` / `border-err` where its assertions survive |
| `apps/web/src/features/sessions/**` (other files) | rewritten | untouched (imported by name: `SessionListScreen`, `SessionScreen({ sessionId })`) | if M2 renamed or re-propped them, adapt `routes/shell/pane-renderers.tsx` only |
| `apps/web/src/runtime/**`, `stores/**` | rewritten (`call(…, options?)`, split reducer) | untouched; M3 reads `getRuntime`, `useConnectionState`, `rpc.call`, `RpcError` | adapt `lib/account-setting.ts` only if a signature moved |
| `apps/web/src/testing/dom.ts`, `runtime-bed.ts` | `runtime-bed.ts` gains `options` | `dom.ts`'s `Mounted` gains `rerender` (Task 17a); `runtime-bed.ts` read only | union |
| `budgets.json`, `scripts/check-budgets.ts` (+ test) | its own provisional budget (M2's Task 30) | provisional values, `lazyAssets`, the final value (Task 32) | take the larger provisional value at the rebase; P6 sets the final one by the rule |
| `apps/web/src/build-output.int.test.ts` | reads `budgets.json` only | new cases (Tasks 1b, 10b, 11, 14, 24, 25, 32) | keep M3's cases |
| `apps/web/src/styles.css` | none | rewritten (Task 1b), phone rules (Task 23) | M3's |
| `DESIGN.md` | ANSI colours rule under §9 (StatusBar/Widgets) | §3 tokens and §7.4 focus (ADR 0012) | different sections: keep both |
| `docs/research/decisions-log.md` | owner decisions of 2026-10-11 appended | none | M2's |
| `packages/ui/**` | none (M2 builds feature components on the existing tokens) | rewritten internally; the must-keep API of agreement 5 kept | P2, P1 |
| `eslint.config.js`, `knip.json` | maybe entries | `pap/no-raw-colors` ignores (`presets.ts`, `contrast.ts`, `derive.ts`), elements `web-lib`, `web-gallery`, allow lists (`contracts` and `web-lib` for routes, `ui` for lib, `web-feature` for root), rule `pap/no-native-title`, browser globals for `apps/web/src/**/*.js`, knip entries for the boot script and `vite/*.ts` | union; `pnpm lint && pnpm knip` |
| `package.json`, `pnpm-lock.yaml` | new deps | `@tailwindcss/node` (root); `radix-ui`, `lucide-react`, `react-markdown`, `remark-gfm`, `shiki` (`@pap/ui`), `cmdk` (`@pap/web`) | resolve `package.json` by hand, then run `pnpm install` to regenerate the lockfile; never hand-merge it |
| `AGENTS.md` | maybe lines | the `docs/agents/web.md` topic note | union |
| `.github/workflows/ci.yml` | maybe a job or step | none (no e2e job, owner C1) | M2's |

**Rebase hints from the final review (round 2).** What the M3 fixes changed under M2's feet, beyond the table above:

- `Toaster` takes a required `regionLabel`: any M2 test that mounts `<Toaster>` must pass it.
- `createAccountDocument`'s `merge` takes a 4th argument `base`; an M2 document that merges by field can ignore it.
- `LazyPanel` moved from `routes/shell/` to `lib/LazyPanel.tsx` and takes a `text` prop (`useLazyFailureText()`); `lib/LazyMenu.tsx` is the shared lazy overlay menu.
- `PANE_RENDERERS.session` goes through `LazyPane`: the session screen is its own chunk. `build-output.int.test.ts` pins it with the marker `"data-failure"` and fails closed; if M2 moves the failure line out of the session subtree, pick another marker only the session screen has.
- Any shell-level test that reads a session pane must `vi.waitFor` it (the screen is lazy).
- P-list item (P6 lever): move M2's `sessions.*` strings (about 68 keys, about 3 KB gzip) from the eager block of `en.ts` / `fr.ts` to a lazy catalog registered by the session chunk (`registerCatalog`, as `settings-screen.ts` does).
- P7 removes the `features/sessions` exclusion in THREE places: the constant `M2_OWNED_UNTIL_P7` in `scripts/class-coverage.ts` and in `apps/web/src/compiler-gate.test.ts:11`, and the `features/sessions/` alternative inside `SKIPPED` in `scripts/literal-coverage.ts` (line 26; drop only that alternative, the regex also skips tests, `testing/` and the gallery). `scripts/class-coverage.test.ts:69-70` imports the constant, so edit it too.
- A dev `PAP_HOME` created on the M3 branch will refuse to open after the rebase: it has the settings migration applied but not M2's policy and session-name migrations, which sort before it (`migrate.ts` refuses "sorts before an applied migration"). Reset that home. Smoke and tests use fresh homes.
- Do not re-stamp M3's settings migration unless M2's final stamp sorts after `202610111000`; a home that already applied it reads a renamed one as `database_newer_than_binary` and opens read-only.
- `@pap/contracts` has `"sideEffects": false`: check that none of M2's contracts files has a top-level side effect, or the web build drops it silently.
- `ApprovalAnswer` is exported by both `@pap/ui` and `@pap/contracts` (M2's is a value plus a type): P3 aliases one of them.
- P3 musts: `min-w-0 truncate` on the ToolCard name before it shows extension names; highlight settled code fences only (or debounce), not every streaming delta.

After the rebase: `pnpm install && pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm smoke && pnpm budgets`, then P7 → P3 → P2 → P1 → P4 → P5 → P6.
