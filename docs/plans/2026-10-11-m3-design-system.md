# pap M3: design system and app shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn DESIGN.md (spec B, validated) into code: the full Night Control token set with three themes and three densities, owned Radix primitives, the first AI components, the logo, appearance settings stored per account and per device, keybindings with `when` clauses and an editor, the Cmd+K palette, the decision-25 app shell on desktop and phone, `/dev/ui`, en + fr everywhere, and the Playwright journey dropped from M1, running in the official Playwright container.

**Architecture:** `packages/ui` owns every visual decision: `tokens.css` maps the DESIGN.md custom properties (`--bg`, `--surface`, `--agent`…) scoped by `[data-theme]` and `[data-density]` onto Tailwind 4 utilities, and the primitives and AI components take a `variant` and a `size`, never a `className`. The web app gains four feature folders (`appearance`, `commands`, `workspace`, plus a shared `lib/`), and `routes/` becomes the shell that composes them: rail, top bar, open-item tabs, splittable panes, ⌘B tree drawer, Inbox drawer, palette, phone bottom nav. Account-scope settings (theme, fonts, labels, grid, rail, avatars, tool detail, keybindings) live in a new daemon `settings` module behind two RPC methods; device-scope settings (density, sizes, motion, chat width) live in `localStorage`. A blocking external boot script, emitted by a Vite plugin, applies the cached appearance before first paint without breaking the strict CSP (R74).

**Tech Stack:** React 19 + React Compiler, Vite 8, Tailwind 4.3.3 (`@theme inline`, `@utility`, `@custom-variant`), `radix-ui` (unified package), `cmdk`, `lucide-react`, TanStack Router, zustand, zod 4 (contracts), `node:sqlite` (daemon `settings` module), Vitest 5 + happy-dom, `@tailwindcss/node` (class-coverage gate), `babel-plugin-react-compiler` (compiler gate), Playwright (Chromium + WebKit) driven through `playwright run-server` inside `mcr.microsoft.com/playwright:v<version>-noble` (podman locally, docker in CI).

**Spec:** `DESIGN.md` (spec B, binding: decision 33), `docs/specs/2026-10-10-C-architecture.md` §7 (frontend) and §8 (gates), `docs/specs/2026-10-10-A-product-scope.md` §5.3, `docs/research/decisions-log.md` decisions 11, 21, 25–28, 32, 33, 36, the validated screens in `docs/design/explorations/05, 08, 12`, `docs/plans/roadmap.md` (M3), `docs/research/m0-m1-rulings.md`, `docs/spikes/s6.md`. Reference code read for this plan (read-only clones under `/home/ubuntu/Workspace/soulkyu/_refs/`): T3 Code and Orca, cited per task as `T3:` and `Orca:`; pi-web (`/home/ubuntu/Workspace/soulkyu/pi-web`, read-only) cited as `pw:`.

## Backlog rulings absorbed

| Ruling | What this plan does | Task |
|---|---|---|
| R120 | Raised as **open question Q1** (DESIGN contrast amendments). The plan implements DESIGN as validated, behind two indirection tokens (`--focus-ring`, `--control-border`) so an amendment is a one-line change per theme. The theme-selector specificity trap and "on-fill only valid on the you fill" are fixed now: every theme selector has the same specificity and each role has its own ink (`--agent-ink`, `--you-ink`, `--attn-ink`). | 1, Q1 |
| R129 | DESIGN.md:367 Playwright screenshots of `/dev/ui` return (3 themes × 2 densities). The two reducer items (linear snapshot reduce, no content dedup for `role:none` refs) live in M2-owned `apps/web/src/stores/session-reducer.ts`: post-merge task P5. | 31, P5 |
| R125 | HMR: every module-level listener M3 adds (`matchMedia`, the key dispatcher) disposes on `import.meta.hot`; shell tests mock the runtime singleton. Stream keying and hidden-tab reconnect throttling are runtime items (M2-owned folder): left to M2, listed in the merge notes. | 15, 17, 19 |
| R118 (T26 checks) | Vite proxy `ws: true` and fonts never inlined as `data:` stay pinned (existing tests kept through the font move). Safari 16.4 CSP for ws: every journey on WebKit asserts zero `securitypolicyviolation` events, the socket included; the explicit-`wss:` fallback is only needed if that fails (daemon change, M2/M5 then). | 1, 29, 30 |
| R122 / R128 "@pap/ui through the Compiler" | A compiler gate transforms every `.tsx` of `packages/ui` and `apps/web` with `babel-plugin-react-compiler` and fails on any `CompileError`/`PipelineError`; a Vite test proves the build pipeline compiles `packages/ui` files. | 2 |
| R128 reactive locale switch | `useT()` / `useLocale()` on `useSyncExternalStore`; Settings › Language switches without reload. | 3, 24 |
| R128 i18n of server cause/notice texts | `serverText()` translates the daemon's current English notice and cause sentences (en + fr); wiring into the M2-owned reducer and a code-based contract are post-merge task P4. | 3, P4 |
| Safari IME keyCode 229 | `cancelsComposition()` (isComposing or keyCode 229, pw: `lib/stacked-dialog.ts`) guards dialog Escape, the submit shortcut and the key dispatcher. | 6, 8, 16 |
| R121 mono-uppercase button labels | Buttons and HUD labels use the `label-hud` utility (mono, 600, 0.12em, `text-transform: var(--label-transform)`), switchable in Settings; the DOM keeps sentence case so selectors never depend on CSS text-transform. | 1, 5 |
| on-fill per role | `--agent-ink`, `--you-ink`, `--attn-ink` per theme; `on-fill` stays an alias of `--you-ink` until P1. | 1 |
| theme selector specificity | A test parses `tokens.css` and allows only `:root, [data-theme="night"]`, `[data-theme="day"]`, `[data-theme="hc"]` and the no-JS fallback `:root:not([data-theme])`. | 1 |
| R53 (S6) | AI components ported with attribution (Message actions/branch, Reasoning), `THIRD_PARTY_NOTICES.md`, Collapsible primitive through ADR 0006. | 7, 9, 10 |
| R51 / decision 36 | The M1 Task 27 journey (setup → login → prompt → approval → result, passkey on Chromium) runs on Chromium and WebKit with the browsers in the official Playwright image (podman locally, docker in CI). | 29, 30 |
| R74 | No inline script anywhere: the pre-paint boot script is an external hashed classic script; the build-output test keeps proving it. | 14 |

## What this plan explicitly defers

- **To post-merge tasks P1–P7** (run once M2 and M3 are both on `main`, see "Merge order and conflict notes"): removing the M1 token aliases, promoting M2's dialog shells / status bar / widgets / custom panel into `packages/ui`, adopting the shell landmarks and AI components in M2's session screen, code-based server texts, R129's reducer items, re-checking e2e selectors against M2's final UI, running the new gates over M2's files.
- **To later milestones**, built on M3's primitives: project switcher and project groups (M4), FTS5 transcript hits in ⌘K (M4), approval scopes wired to the policy (M5), DiffView with CodeMirror merge (R50, M8/M9), terminal/diff/review pane kinds (M8/M9), CheckpointBanner and CompareColumn (M9), TriggerVerdict and the Tasks board (M10), agent avatars in the rail, EventCard, PendingRequestsStrip, PromptChips, the Inbox stream and agent status panel (M11), PWA manifest, service worker and push (M12). The rail, Inbox drawer and phone "Agents" tab ship with empty states.
- **Not in v1 at all** (DESIGN §13): custom CSS, full cross-device sync.

## Global Constraints

Copied from the specs and the binding rulings (source in brackets). Every task implicitly includes them.

- Node 24: "Boring tech. TypeScript on Node 24, SQLite, React; no Effect, no SSR." [A §3] · `engines.node` `>=24.14 <25` [R44]
- File size: "400 lines per file at most. No baseline, no exceptions." [C §1.4.2] — enforced by ESLint `max-lines` and `scripts/source-guards.ts` [R64c]
- Module boundary: "A module imports only `contracts`, `kernel` and other modules' `index.ts`." [C §1.4.1]
- RPC handlers: "An RPC handler decodes the request, calls one service method and maps typed errors. Nothing else." [C §1.4.3]
- Permissions: "Every RPC method declares a permission in `contracts`. A missing permission is a type error." [C §1.4.4]
- Packages: "No fourth package until a real need appears." [C §1.4.6]
- UI look: "Primitives in `packages/ui` own their look: no raw colours, no arbitrary values." [C §1.4.5] · "Each primitive owns its look: callers pick a `variant` and a `size`, never a `className` restyle." [DESIGN §9.1]
- "No gradients and no glow, ever." [DESIGN §1] · "Surfaces never cast shadows." [DESIGN §3.4] · "Nothing repaints continuously." [DESIGN §7.2]
- Focus: "A 2 px solid `--you-fill` outline with a 2 px offset on `:focus-visible`. It is never removed." [DESIGN §7.4]
- Touch: "Under `pointer: coarse`, every interactive target is at least **44 × 44 px**, whatever the density." [DESIGN §5]
- Fonts: "self-hosted as woff2 in `packages/ui`. No font CDN at runtime" [DESIGN §4]
- Icons: "lucide, with a 1.5 px stroke, in `currentColor`… Every icon-only button has an accessible label and a tooltip; the native `title` attribute is not used." [DESIGN §7.1]
- Copy: "Every string goes through the internal i18n layer; no string is concatenated around variables." · "Never overclaim" · "No exclamation marks in system copy." [DESIGN §11] · UI languages en + fr [A §5.3, C §7.3]
- Browser floor: "The Safari / iOS 16.4 floor, pinned by a test." [C §7.3] — no CSS or JS above Safari 16.4 (no native CSS nesting in shipped CSS, no `light-dark()`, no `field-sizing`) [R50, S6]
- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'` — no inline script, no `eval`; relaxing a directive needs an ADR [R74]
- Zero telemetry: nothing loads from the network at runtime [C §9.4, DESIGN §4]
- Errors: "Errors carry a stable code and a fixed message, with no user content and no secrets." [C §4.1]
- Mutations carry a `commandId` (`idempotent: false`); reads are `idempotent: true` [R65b]
- Lint discipline: the only directive accepted is `eslint-disable-next-line <rule> -- <reason>` [R64b, AGENTS.md]
- Supply chain: dependencies pinned exactly with `pnpm add -E <pkg>` (no range) [R56]; `minimumReleaseAge` 3 days (pnpm picks the newest version old enough; record the version it chose in the commit message); no new build script unless listed in `onlyBuiltDependencies` / `ignoredBuiltDependencies` [R36]
- Git: Conventional Commits, rebase before PR [C §8.3]; commit messages must NOT contain `Co-Authored-By` or any AI attribution trailer (owner rule)
- Never edit pi-web; pap imports nothing from it [D §1]. Never use port 30141.
- Design changes go through an ADR in `docs/adr/` [decision 33]
- Implementers run `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/m1-lessons-checklist.md` on their diff and report each item ✅ / n/a. [controller, owner-approved]
- The host is a headless VPS: no graphics, no Chrome/libatk, no sudo. Every browser check runs headless inside `mcr.microsoft.com/playwright:v<exact @playwright/test version>-noble` through rootless podman (`pnpm e2e`, Task 29) or in CI with docker; everything else is a unit or integration test that needs no browser. [R51, controller]
- Work only under `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m3` with absolute paths (the session's default directory may be pi-web); never write to pi-web or to the M2 worktree. [brief, checklist]
- Web-side waits: client RPC calls get no deadline of their own because the runtime settles every call when the socket is declared dead (spec C §4.2 keepalive, 15 s); a mutation that ends in `timeout` or `connection_lost` is never re-sent by itself (R105). Scripts that wait on processes or containers (`scripts/e2e.ts`, e2e global setup) carry explicit deadlines. [checklist]

## Plan conventions

- Working directory for every command: the M3 worktree root `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m3`.
- pnpm comes from the corepack shim (R55): prefix commands with `PATH="/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/bin:$PATH"`. If that worktree is gone, recreate the shim in this worktree: `mkdir -p .superpowers/bin && corepack enable --install-directory .superpowers/bin` (git-ignored) and use that path. Commands below write `pnpm` for short.
- TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep their `.ts`/`.tsx` extension.
- Tests never touch `~/.pi/agent` or `~/.pap`. Web tests use happy-dom (`// @vitest-environment happy-dom`) and the helpers of `apps/web/src/testing/dom.ts`; timers are injected or use `vi.useFakeTimers()`; no sleeps.
- Every task ends with: `pnpm format` on its own files, then `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit` green (plus `pnpm test:int` when the task touches the daemon or the build), then the commit shown.
- New strings: every task that adds visible text adds its en and fr keys to the namespace catalog named in the task (Task 3 sets them up). French keeps sentence case and French typography (a space before `:` and `?`).
- Class lists live only in a `className` attribute, a `cn(...)` call, or an UPPER_CASE constant whose name ends in `CLASSES`, `VARIANTS`, `SIZES`, `TONES`, `STYLE` or `RING` (the class-coverage gate of Task 2 reads exactly those places).
- Every primitive and AI component root carries `data-slot="<name>"` (T3/Orca convention: stable hooks for tests and parent rules, never for restyling).
- Where a task gives test cases as bullets instead of code (UI screens), each bullet is one `it(...)` with exactly the inputs, selectors and expected values it states; the implementer writes them as code and sees them fail before writing the implementation (checklist: tests prove something). Code is given in full for contracts, security-relevant logic and every pure core (tokens, chords, `when`, merge, workspace, separator, ranking, theme derivation, e2e runner).

## Review Focus

Inputs and conditions the specs imply, that no feature test naturally exercises, and that are most likely to bite a person using pap. Each line names the test that pins it.

1. **Stale or corrupt local state after an upgrade** (a `pap.appearance.boot`, `pap.workspace.v1` or `pap.appearance.device.v1` written by another version, edited by hand, or `localStorage` throwing in a locked-down browser). Expected: pap boots with defaults, never a blank page or a crash loop. Pinned by: Task 14 `boot-script.test.ts` "ignores garbage, unknown keys and throwing storage", Task 18 `persist.test.ts` "drops a workspace of another version or shape", Task 13 `model.test.ts` "device settings parse fail-soft", Task 15 `controller.test.ts` "marks device settings as page-only when storage refuses them".
2. **Typing with an input method or a non-US layout** (Japanese/Chinese IME in Safari reporting keyCode 229, French AZERTY where Ctrl+Alt is AltGr, Cyrillic with Ctrl). Expected: no shortcut fires during composition, Escape cancels the composition instead of closing a dialog, AltGr characters still type, Ctrl+K still works on a Cyrillic layout. Pinned by: Task 16 `keys.test.ts` (229, isComposing, `Process`, AltGraph, Cyrillic with Ctrl, mac Option+letter, AZERTY digits), Task 17 `dispatcher.test.ts` (composition), Task 8 `Dialog.test.tsx` "does not close on the Escape that ends a Safari composition", Task 6 `submit-shortcut.test.ts` (229).
3. **Imported JSON from outside** (a theme or keybindings file that is malformed, oversized, or carries `url(...)` / script-looking values). Expected: a precise error per entry, nothing half-applied, no value other than a hex colour ever reaches a style property, the server refuses oversize payloads. Pinned by: Task 12 `service.test.ts` "refuses a value over 128 KiB" and `settings.test.ts` "lets only hex colours into a theme", Task 13 `derive.test.ts` "only hex colours reach the token map", Task 14 `boot-script.test.ts` (hostile cache values), Task 26 `theme-io.test.ts`, Task 27 `keybindings-io.test.ts`.
4. **A shortcut the browser keeps** (Ctrl+W, Ctrl+T, Ctrl+N, Cmd+Q, Ctrl+Tab, Ctrl+1..9) chosen in the editor. Expected: the editor says the browser may keep it instead of saving a binding that silently never fires. Pinned by: Task 16 `resolve.test.ts` "flags browser-reserved chords", Task 27 `ShortcutsEditor.test.tsx` (the recorder refuses `Ctrl+W`) and `keybindings-io.test.ts` (reserved warning).
5. **A link or a restored tab to something that is gone** (a session id that no longer exists, `/settings/unknown`, `/dev/ui` in a production build). Expected: a not-found screen with a way home, a closable tab, never a redirect loop. Pinned by: Task 18 `item-path.test.ts` and `persist.test.ts`, Task 19 `AppShell.test.tsx` "unknown path shows not found without opening a tab", Task 32 build-output test "ships no gallery in the production build", Task 30 `shell.spec.ts` "an unknown address shows the not-found screen".

## Coordination with M2 (parallel worktree)

Ownership is the planning brief's contract. M3 owns `packages/ui/**`, `apps/web/src/styles.css`, `apps/web/index.html`, `apps/web/src/routes/**`, the `apps/web/src/i18n/**` structure, theming and appearance settings, keybindings, Cmd+K, `/dev/ui`, the Playwright journey and the browser e2e CI job. M2 owns `apps/daemon/**`, `packages/pi-host/**`, `packages/contracts/**`, `apps/web/src/runtime/**`, `apps/web/src/stores/**` and `apps/web/src/features/sessions/**`.

What M3 also touches, and why (all listed again in "Merge order and conflict notes"):

| Shared file | M3 change | Size |
|---|---|---|
| `packages/contracts/src/permissions.ts` | add `"settings"` to `DOMAINS` | 1 line |
| `packages/contracts/src/methods.ts` | import `settingsMethods`, spread it first in the catalogue | 2 lines |
| `packages/contracts/src/index.ts` | `export * from "./settings.ts";` | 1 line |
| `packages/contracts/src/methods.test.ts` | add `"settings.set"` to the mutation list | 1 line |
| `apps/daemon/src/daemon.ts` | import the settings module, add its migrations and handlers | 4 lines |
| `apps/web/src/i18n/en.ts`, `fr.ts` | import the M3 namespace catalogs and spread them first; existing keys untouched | 4 lines each |
| `apps/web/src/main.tsx`, `vite.config.ts`, `src/build-output.int.test.ts`, `src/vite-config.test.ts` | boot script, providers, compiler include, CSP checks | M3 only (not in M2's list) |
| `apps/web/src/features/auth/**` | restyle and move "Add a passkey" into Settings | M3 only (not in M2's list) |
| `eslint.config.js`, `knip.json`, `package.json`, `pnpm-lock.yaml`, `.github/workflows/ci.yml` | new rule, new boundary elements, deps, e2e job | root files both may touch |

New files only: `packages/contracts/src/settings.ts`, `apps/daemon/src/modules/settings/**`.

**Pipelining with M2.** No M3 task waits for an M2 merge: every task builds on `main` as it is (f765f2a) and renders M2's screens as they exist there. The post-merge tasks P1–P7 wait for both milestones (see "Merge order and conflict notes"). M3 does not rebase on `main` in the middle of the milestone, only before its PR, so M2's merge never forces a mid-milestone rework.

M3 reads M2-owned code only through stable surfaces: `getRuntime()` / `rpc.call` / `useConnectionState` from `apps/web/src/runtime/index.ts`, `sessions.list` from the catalogue, and the screens `SessionListScreen()` and `SessionScreen({ sessionId })` from `apps/web/src/features/sessions/`, which the shell renders inside panes. M3 keeps every `@pap/ui` export of `main` working (`Button`, `TextField`, `Message`, `ApprovalCard`, `cn`, `once`, `FOCUS_RING`, and the M1 utility names `bg-panel`, `border-line`, `text-human*`, `text-on-fill`, `text-attention*`, `text-error`, `text-fg`, `text-muted`… as aliases) until P1.

## Pre-execution conflict scan

Tasks run one at a time (subagent-driven). These pairs share files or interfaces; keep the order and re-read the earlier task's result before starting the later one.

| Tasks | Shared file or interface | Rule |
|---|---|---|
| 1 → 2, 4–11 | `packages/ui/src/tokens.css` utility names (`label-hud`, `focus-ring`, `h-control`, `p-s*`, `state-*` variants) | Task 1 is the vocabulary; later tasks use only names its `token-classes.test.ts` pins |
| 2 → every UI task | class-coverage and compiler gates | a later task that adds a class Tailwind cannot generate fails Task 2's test: fix the class, never the allowlist |
| 3 → every task adding text or a client `catch` | `apps/web/src/i18n/catalog/*.ts`, `apps/web/src/lib/report.ts` | each task appends to its own namespace block; every client catch reports or surfaces |
| 4–11 | `packages/ui/src/index.ts` exports | append-only, alphabetical within each group |
| 5, 6, 7, 8 → 9, 10 | `Button`, `Chip`, `Collapsible`, `Tooltip` APIs | AI components consume the primitive props exactly as produced |
| 12 → 13, 15, 17, 26, 27 | `packages/contracts/src/settings.ts` (`AccountAppearance`, `KeybindingRules`, `settings.get/set`) | schemas are the single source for server validation and client import checks |
| 13 → 14, 15, 25, 26 | `features/appearance/model.ts`, `derive.ts`, `contrast.ts` | pure model first, runtime and UI after |
| 14 → 15 | `apply.ts` (`applyAppearance`, `writeBootCache`, `BOOT_KEY`) | the controller only calls the applier |
| 16 → 17, 22, 27 | `features/commands/keys.ts`, `when.ts`, `resolve.ts`, `defaults.ts` | core before dispatcher, palette and editor |
| 18 → 19, 20, 21, 23 | `features/workspace/model.ts`, `workspace-store.ts`, `item-path.ts` | model before shell |
| 19 → 20–25, 28 | `routes/shell/AppShell.tsx`, `routes/router.tsx`, `routes/shell/pane-renderers.tsx` | one shell task at a time; renderers are replaced in the map, never special-cased |
| 24 → 25, 27 | `routes/settings/sections.tsx` (`SETTINGS_SECTION_RENDERERS`) | sections plug into the map Task 24 creates |
| 14, 28 | `apps/web/vite.config.ts` | 14 adds the boot plugin; 28's gallery config merges it, never edits it |
| 2, 3, 14, 15, 28, 29 | `eslint.config.js`, `knip.json` | append entries, never reorder |
| 29 → 30, 31 | `playwright.config.ts`, `e2e/state.ts`, `e2e/guards.ts`, `scripts/e2e.ts` | infra before journeys and screenshots |
| 1, 4, 5, 22, 29 | `package.json` / `pnpm-lock.yaml` (`@tailwindcss/node`, `lucide-react`, `radix-ui`, `cmdk`, `@playwright/test`) | one `pnpm add -E` per task, lockfile committed with it |

## File Structure

```
packages/ui/
  package.json                     exports ".", "./tokens.css", "./fonts.css"; deps radix-ui, lucide-react
  fonts/*.woff2 + *-OFL.txt        Manrope, JetBrains Mono (moved from apps/web/src/fonts)
  src/tokens.css                   themes night/day/hc, densities, Tailwind mapping, utilities, variants
  src/fonts.css                    @font-face, self-hosted
  src/token-names.ts               THEME_TOKENS, THEMES, DENSITIES (single list for tests and the theme editor)
  src/presets.ts                   PRESET_TOKENS (DESIGN §3 values, checked against tokens.css)
  src/feedback.ts                  feedbackPhase, usePendingFeedback, usePendingAction (DESIGN §7.3)
  src/format.ts                    formatCost, formatDuration, formatDiffCounts (DESIGN §11)
  src/media.ts                     useMediaQuery, useIsPhone (internal)
  src/icons.ts                     Icon + curated lucide re-exports
  src/primitives/                  Button, IconButton, Tooltip, Kbd, TextField, Select, Switch, Checkbox, Slider,
                                   Segmented, Chip, Badge, Avatar, Meter, ProgressBar, Spinner, Banner, EmptyState,
                                   OpenTab, Collapsible, Dialog, Menu, Toast (+ submit-shortcut, composition)
  src/ai/                          Message (+actions, branch), AuthorGroup, DaySeparator, RunStatusChip, Fence,
                                   Reasoning, ToolCard, ApprovalCard
  src/brand/                       Mark, Wordmark
apps/web/
  index.html                       title, viewport, icons; the boot script is injected by the plugin
  vite.config.ts                   + appearanceBoot() plugin, compiler include check
  vite.gallery.config.ts           standalone gallery build (test artifact, never shipped)
  gallery.html                     gallery entry
  vite/appearance-boot.ts          Vite plugin: emits the hashed classic boot script
  icons-src/*.svg                  favicon tile, maskable PWA icon sources
  public/favicon.svg, public/icons/*.png
  src/main.tsx                     boot order, providers
  src/styles.css                   tailwind + @pap/ui tokens/fonts + base
  src/lib/                         report.ts (bounded client issue log), account-setting.ts (settings.get/set, saver)
  src/i18n/                        index.ts (+useT/useLocale), catalog/{shell,settings,commands,gallery}.ts,
                                   server-text.ts, literal-coverage.test.ts
  src/features/appearance/         model, derive, contrast, boot-script.js, apply, controller, appearance-store,
                                   AppearancePanel (+ sections, preview), ThemeEditor, CustomThemes, theme-io
  src/features/commands/           keys, when, defaults, resolve, labels, registry, dispatcher, context,
                                   keybindings-store, use-command, ShortcutsHelp, palette/{rank,CommandPalette},
                                   editor/{ShortcutsEditor,ShortcutRecorder,keybindings-io}
  src/features/workspace/          model, item-path, persist, workspace-store, separator, SplitView
  src/routes/                      router, RootLayout (auth gate)
  src/routes/shell/                AppShell, Rail, TopBar, TabBar, PaneHost, pane-renderers, TreeDrawer, SessionTree,
                                   session-groups, InboxDrawer, MobileShell, BottomNav, TabSwitcher, ConnectionBanner,
                                   NotFound, PaletteHost, palette-items, shell-commands, shell-context, sessions-cache,
                                   use-shell-effects, use-viewport-height
  src/routes/settings/             SettingsScreen, sections, LanguageSection, AccountSection
  src/gallery/                     Gallery, sections/*, fixtures, main.tsx (standalone entry)
  src/compiler-gate.test.ts        React Compiler gate
apps/daemon/src/modules/settings/  index, service, store, rpc, migrations/202610111000_settings.sql
packages/contracts/src/settings.ts AccountAppearance, KeybindingRules, settingsMethods
scripts/class-coverage.ts (+test), scripts/literal-coverage.ts (+test), scripts/tailwind-compile.ts,
scripts/e2e.ts (+ e2e-config.test.ts), scripts/icon-list.ts, scripts/render-icons.ts (+ icons.test.ts)
e2e/                               state, global-setup, global-teardown, auth, guards, owner-journey, shell, phone,
                                   gallery specs, fixtures/approval-script.json, __screenshots__/
playwright.config.ts
THIRD_PARTY_NOTICES.md             AI Elements (Apache-2.0) notice
docs/adr/0006-collapsible-primitive.md, docs/adr/0007-dev-ui-not-shipped.md, docs/agents/web.md
```

---
# Phase 1 — Foundations

### Task 1: DESIGN.md tokens — three themes, three densities, utilities, fonts in `packages/ui`

Replaces the M1 subset with the whole of DESIGN.md §3–§5 and §7. Raw values use DESIGN.md's names (`--bg`, `--surface-2`, `--you-ink`…); Tailwind sees them through `@theme inline`. The M1 utility names stay as aliases until post-merge task P1, because M2's screens use them.

**Files:**
- Modify: `packages/ui/src/tokens.css` (rewrite), `packages/ui/src/tokens.test.ts` (rewrite), `packages/ui/src/focus.ts`, `packages/ui/src/index.ts`, `packages/ui/package.json`
- Modify: `packages/ui/src/primitives/Button.test.tsx`, `packages/ui/src/primitives/TextField.test.tsx` (focus-ring expectations only)
- Create: `packages/ui/src/token-names.ts`, `packages/ui/src/presets.ts`, `packages/ui/src/fonts.css`
- Move: `apps/web/src/fonts/*` → `packages/ui/fonts/` (`git mv`), delete `apps/web/src/fonts.css`
- Modify: `apps/web/src/styles.css`, `apps/web/src/build-output.int.test.ts` (no native nesting)
- Create: `scripts/tailwind-compile.ts`, `scripts/token-classes.test.ts`
- Modify: root `package.json`, `pnpm-lock.yaml` (`@tailwindcss/node` pinned to the `tailwindcss` version, 4.3.3)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - CSS custom properties per theme (`:root, [data-theme="night"]`, `[data-theme="day"]`, `[data-theme="hc"]`, no-JS fallback): every name of `THEME_TOKENS` plus `--shadow-overlay`, `--focus-ring`, `--control-border`; per density (`[data-density="compact|comfortable|mixed"]`): `--size-ui`, `--size-chat`, `--leading-chat`, `--size-code`, `--space-1..6`, `--control-h`, `--rail-w`, `--bar-h`, `--avatar-size`; global: `--font-ui`, `--font-code`, `--label-transform`, `--motion-fast`, `--motion-base`, `--grid-size`, `--chat-max-width`.
  - Attributes on `<html>` read by CSS: `data-theme`, `data-density`, `data-font-ui="system"`, `data-font-mono="system"`, `data-labels="sentence"`, `data-grid="off"`, `data-rail="right"`, `data-motion="system|reduced|none"`, `data-chat-width="wide|narrow"`, `data-keyboard-open`.
  - Utilities: colours `bg-|text-|border-|fill-|outline-` × `bg, bg-side, surface, surface-2, border, border-strong, control-border, fg, muted, dim, agent, agent-fill, agent-ink, you, you-fill, you-ink, you-tint, you-line, you-text, attn, attn-fill, attn-ink, attn-tint, attn-line, ok, err, diff-add, diff-del, focus` (+ M1 aliases `panel, line, human, human-fill, human-tint, human-line, human-text, on-fill, attention, attention-tint, attention-line, error`); text sizes `text-label, text-ui, text-chat, text-code, text-h2, text-h1, text-display`; `tracking-label`, `tracking-display`; radii `rounded-sm` (2 px), `rounded-md` (3 px); spacing `p-s1..s6` (any spacing utility), `h-control`, `h-bar`, `w-rail`, `size-avatar`, `w-drawer-tree`, `w-drawer-inbox`, `min-w-pane`, `w-status-panel`; custom `label-hud`, `focus-ring`, `shadow-overlay`, `bg-grid`, `h-app`, `max-h-app`, `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe`, `duration-fast`, `duration-base`, `animate-indeterminate`, `animate-overlay-in`, `max-w-chat`; class `theme-swap` (plain CSS).
  - Variants: `can-hover:`, `rail-right:`, `state-open:`, `state-closed:`, `state-checked:`, `state-on:`, `state-active:`.
  - `packages/ui/src/token-names.ts`: `THEME_TOKENS`, `type ThemeToken`, `THEMES = ["night","day","hc"]`, `type ThemeName`, `DENSITIES = ["compact","comfortable","mixed"]`, `type Density`.
  - `packages/ui/src/presets.ts`: `PRESET_TOKENS: Readonly<Record<ThemeName, Readonly<Record<ThemeToken, string>>>>`.
  - `FOCUS_RING = "focus-ring"` (same export, new value).
  - `@pap/ui/fonts.css` export.
  - `scripts/tailwind-compile.ts`: `compileStyles(): Promise<(candidates: readonly string[]) => string>`, `escapeClass(name: string): string`, `ruleOf(css: string, className: string): string`.

**Risks / rulings needed:** (a) Tailwind 4.3.3 must resolve named `--spacing-*` keys (`p-s3`, `w-drawer-tree`): pinned by the test, fallback in Step 6, no ruling. (b) The high-contrast values DESIGN §3.3 leaves out (inks, tints, lines, `--you-text`, diff tones) are derived by §13.2's rules: the controller confirms this is an implementation of §13.2, not a design change (else ADR). (c) Comfortable density lists five spacing steps; `--space-6` repeats 32 px: confirm.

- [ ] **Step 1: Pin `@tailwindcss/node` and move the fonts**

Run:
```bash
pnpm add -Dw -E @tailwindcss/node@4.3.3
git mv apps/web/src/fonts packages/ui/fonts
git rm apps/web/src/fonts.css
```
Expected: `package.json` gains `"@tailwindcss/node": "4.3.3"`; `packages/ui/fonts/` holds the four woff2 files and both OFL texts.

- [ ] **Step 2: Write the token name list and the presets**

`packages/ui/src/token-names.ts`:

```ts
/** DESIGN.md §3: the custom properties every theme defines. The theme editor, the presets and the tests read this list. */
export const THEME_TOKENS = [
  "bg",
  "bg-side",
  "surface",
  "surface-2",
  "border",
  "border-strong",
  "text",
  "text-muted",
  "text-dim",
  "grid",
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

`packages/ui/src/presets.ts` (values from DESIGN.md §3.1–3.3; the values §3.3 leaves out follow §13.2: inks, tints and lines come from the fills, which high contrast keeps from night; diff tones are the high-contrast ok/err at 8 % alpha):

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
  text: "#f2effa",
  "text-muted": "#9c95b5",
  "text-dim": "#6b6485",
  grid: "#ffffff06",
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
  "attn-ink": "#ffffff",
  "attn-tint": "#ec48991a",
  "attn-line": "#ec48998c",
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
  text: "#1c1917",
  "text-muted": "#6b645a",
  "text-dim": "#a8a196",
  grid: "#1c19170a",
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
  text: "#ffffff",
  "text-muted": "#d0d0d0",
  "text-dim": "#a0a0a0",
  grid: "transparent",
  agent: "#c4b5fd",
  you: "#fdba74",
  attn: "#f9a8d4",
  ok: "#6ee7b7",
  err: "#fca5a5",
  "diff-add": "#6ee7b714",
  "diff-del": "#fca5a514",
};

/** DESIGN.md §3.1–3.3, lower case. `tokens.test.ts` proves tokens.css says exactly the same. */
export const PRESET_TOKENS: Readonly<Record<ThemeName, Tokens>> = { night, day, hc };
```

- [ ] **Step 3: Write the failing token tests**

`packages/ui/src/tokens.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESET_TOKENS } from "./presets.ts";
import { THEME_TOKENS } from "./token-names.ts";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const fonts = readFileSync(new URL("./fonts.css", import.meta.url), "utf8");

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

const blocks = parse(css);
const themeBlocks = blocks.filter((block) => block.decls.has("--bg"));
const PER_THEME = [...THEME_TOKENS.map((name) => `--${name}`), "--shadow-overlay", "--focus-ring", "--control-border"];

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

  it("draws the focus ring with the you fill in every theme, through one token (R54, R120)", () => {
    for (const block of themeBlocks) {
      expect(block.decls.get("--focus-ring")).toBe("var(--you-fill)");
      expect(block.decls.get("--control-border")).toBe("var(--border-strong)");
    }
  });

  it("gives each role its own ink", () => {
    expect(PRESET_TOKENS.night["agent-ink"]).toBe("#110f18");
    expect(PRESET_TOKENS.day["agent-ink"]).toBe("#ffffff");
    expect(PRESET_TOKENS.night["attn-ink"]).toBe("#ffffff");
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

  it("switches HUD labels to sentence case with one attribute", () => {
    expect(blocks.find((b) => b.selector === '[data-labels="sentence"]')?.decls.get("--label-transform")).toBe("none");
  });

  it("loads nothing from the network and serves its own woff2 files", () => {
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(fonts).not.toMatch(/https?:\/\//);
    expect(fonts).toContain("font-display: swap");
    for (const match of fonts.matchAll(/url\("([^"]+)"\)/g)) {
      expect(existsSync(new URL(match[1] ?? "", new URL("./fonts.css", import.meta.url))), match[1]).toBe(true);
    }
  });
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
 * The web app's real stylesheet (Tailwind, @pap/ui tokens and fonts), compiled fresh: the returned function builds
 * the CSS for exactly the classes given. A fresh compiler per call keeps one test's classes out of another's output.
 */
export async function compileStyles(): Promise<(candidates: readonly string[]) => string> {
  const compiler = await compile(readFileSync(STYLES, "utf8"), { base: dirname(STYLES), onDependency: () => {} });
  return (candidates) => compiler.build([...candidates]);
}

/** The text from a class's selector to the end of its rule, or "" when the CSS has no rule for it. */
export function ruleOf(css: string, className: string): string {
  const at = css.indexOf(`.${escapeClass(className)}`);
  return at === -1 ? "" : css.slice(at, css.indexOf("}", at) + 1);
}
```

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

  it("compiles nothing for a default palette colour", async () => {
    expect(await rule("bg-red-500")).toBe("");
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm test:unit packages/ui/src/tokens.test.ts scripts/token-classes.test.ts`
Expected: FAIL (`presets.ts` values differ from the M1 file, `fonts.css` missing, utilities such as `label-hud` produce no rule).

- [ ] **Step 5: Write `tokens.css`**

`packages/ui/src/tokens.css`:

```css
/* Night Control tokens: DESIGN.md §3 (themes), §5 (densities), §7.2 (motion), §7.4 (focus); spec B, validated
   (decision 33). Raw values carry the DESIGN.md names; Tailwind sees them through @theme inline. Every theme
   selector has the same specificity (R120): the boot script always sets data-theme, the no-JS fallback only
   applies while the attribute is absent. --focus-ring and --control-border are the one place to amend if the
   owner changes the contrast values (open question Q1). The default Tailwind palette is reset: only the colours
   below compile (transparent and current stay built in). Nothing here loads from the network. */

@custom-variant can-hover (@media (hover: hover));
@custom-variant rail-right (&:where([data-rail="right"], [data-rail="right"] *));
@custom-variant state-open (&[data-state="open"]);
@custom-variant state-closed (&[data-state="closed"]);
@custom-variant state-checked (&[data-state="checked"]);
@custom-variant state-on (&[data-state="on"]);
@custom-variant state-active (&[data-state="active"]);

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

:root,
[data-theme="night"] {
  color-scheme: dark;
  --bg: #110f18;
  --bg-side: #14111d;
  --surface: #1a1724;
  --surface-2: #241f33;
  --border: #2d2840;
  --border-strong: #3d3657;
  --text: #f2effa;
  --text-muted: #9c95b5;
  --text-dim: #6b6485;
  --grid: #ffffff06;
  --agent: #a78bfa;
  --agent-fill: #a78bfa;
  --agent-ink: #110f18;
  --you: #fb923c;
  --you-fill: #fb923c;
  --you-ink: #1b0d00;
  --you-tint: #fb923c1a;
  --you-line: #fb923c66;
  --you-text: #fed7aa;
  --attn: #ec4899;
  --attn-fill: #ec4899;
  --attn-ink: #ffffff;
  --attn-tint: #ec48991a;
  --attn-line: #ec48998c;
  --ok: #34d399;
  --err: #f87171;
  --diff-add: #34d39914;
  --diff-del: #f8717114;
  --shadow-overlay: 0 20px 60px rgba(0, 0, 0, 0.6);
  --focus-ring: var(--you-fill);
  --control-border: var(--border-strong);
}

[data-theme="day"] {
  color-scheme: light;
  --bg: #faf9f6;
  --bg-side: #f3f1ec;
  --surface: #ffffff;
  --surface-2: #eeebe4;
  --border: #e2ded5;
  --border-strong: #cfc9bc;
  --text: #1c1917;
  --text-muted: #6b645a;
  --text-dim: #a8a196;
  --grid: #1c19170a;
  --agent: #6d28d9;
  --agent-fill: #7c3aed;
  --agent-ink: #ffffff;
  --you: #c2410c;
  --you-fill: #fb923c;
  --you-ink: #1b0d00;
  --you-tint: #fff4ea;
  --you-line: #fdba74;
  --you-text: #431407;
  --attn: #be185d;
  --attn-fill: #db2777;
  --attn-ink: #ffffff;
  --attn-tint: #fdf1f6;
  --attn-line: #f9a8d4;
  --ok: #047857;
  --err: #dc2626;
  --diff-add: #04785714;
  --diff-del: #dc262614;
  --shadow-overlay: 0 12px 40px rgba(28, 25, 23, 0.18);
  --focus-ring: var(--you-fill);
  --control-border: var(--border-strong);
}

/* DESIGN.md §3.3; what §3.3 leaves out follows §13.2 (inks, tints and lines from the night fills it keeps). */
[data-theme="hc"] {
  color-scheme: dark;
  --bg: #000000;
  --bg-side: #0a0a0a;
  --surface: #111111;
  --surface-2: #1f1f1f;
  --border: #5a5a5a;
  --border-strong: #8a8a8a;
  --text: #ffffff;
  --text-muted: #d0d0d0;
  --text-dim: #a0a0a0;
  --grid: transparent;
  --agent: #c4b5fd;
  --agent-fill: #a78bfa;
  --agent-ink: #110f18;
  --you: #fdba74;
  --you-fill: #fb923c;
  --you-ink: #1b0d00;
  --you-tint: #fb923c1a;
  --you-line: #fb923c66;
  --you-text: #fed7aa;
  --attn: #f9a8d4;
  --attn-fill: #ec4899;
  --attn-ink: #ffffff;
  --attn-tint: #ec48991a;
  --attn-line: #ec48998c;
  --ok: #6ee7b7;
  --err: #fca5a5;
  --diff-add: #6ee7b714;
  --diff-del: #fca5a514;
  --shadow-overlay: 0 20px 60px rgba(0, 0, 0, 0.6);
  --focus-ring: var(--you-fill);
  --control-border: var(--border-strong);
}

/* No JavaScript yet (or ever): follow the system. Applies only while <html> has no data-theme. */
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    color-scheme: light;
    --bg: #faf9f6;
    --bg-side: #f3f1ec;
    --surface: #ffffff;
    --surface-2: #eeebe4;
    --border: #e2ded5;
    --border-strong: #cfc9bc;
    --text: #1c1917;
    --text-muted: #6b645a;
    --text-dim: #a8a196;
    --grid: #1c19170a;
    --agent: #6d28d9;
    --agent-fill: #7c3aed;
    --agent-ink: #ffffff;
    --you: #c2410c;
    --you-fill: #fb923c;
    --you-ink: #1b0d00;
    --you-tint: #fff4ea;
    --you-line: #fdba74;
    --you-text: #431407;
    --attn: #be185d;
    --attn-fill: #db2777;
    --attn-ink: #ffffff;
    --attn-tint: #fdf1f6;
    --attn-line: #f9a8d4;
    --ok: #047857;
    --err: #dc2626;
    --diff-add: #04785714;
    --diff-del: #dc262614;
    --shadow-overlay: 0 12px 40px rgba(28, 25, 23, 0.18);
    --focus-ring: var(--you-fill);
    --control-border: var(--border-strong);
  }
}

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

[data-motion="reduced"] .animate-indeterminate,
[data-motion="none"] .animate-indeterminate {
  animation: none;
}

@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion]),
  [data-motion="system"] {
    --motion-fast: 0ms;
    --motion-base: 0ms;
  }

  :root:not([data-motion]) .animate-indeterminate,
  [data-motion="system"] .animate-indeterminate {
    animation: none;
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

@keyframes pap-indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

@keyframes pap-overlay-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* DESIGN.md §4 HUD label: mono 10.5 px, 600, 0.12em, upper case unless the owner turned it off. */
@utility label-hud {
  font-family: var(--font-code);
  font-size: 0.65625rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: var(--label-transform);
}

/* DESIGN.md §7.4. Never removed. */
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

@utility pt-safe {
  padding-top: env(safe-area-inset-top, 0px);
}

@utility pb-safe {
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

@utility pl-safe {
  padding-left: env(safe-area-inset-left, 0px);
}

@utility pr-safe {
  padding-right: env(safe-area-inset-right, 0px);
}

@utility duration-fast {
  transition-duration: var(--motion-fast);
}

@utility duration-base {
  transition-duration: var(--motion-base);
}

/* The one continuous animation DESIGN.md §7.2 allows: the running tool card's bar. Static under reduced motion. */
@utility animate-indeterminate {
  animation: pap-indeterminate 1.4s linear infinite;
}

@utility animate-overlay-in {
  animation: pap-overlay-in var(--motion-base) ease-out;
}

@utility max-w-chat {
  max-width: var(--chat-max-width);
}
```

`packages/ui/src/fonts.css`: the four `@font-face` rules of the deleted `apps/web/src/fonts.css`, unchanged except `src: url("../fonts/<file>.woff2") format("woff2");`, under the same header comment.

`packages/ui/src/focus.ts`:

```ts
/** DESIGN.md §7.4: a 2 px solid --focus-ring (the you fill) outline, offset 2 px, on :focus-visible. Never removed. */
export const FOCUS_RING = "focus-ring";
```

`packages/ui/package.json` `exports`: add `"./fonts.css": "./src/fonts.css"`.

`packages/ui/src/index.ts`: append

```ts
export { PRESET_TOKENS } from "./presets.ts";
export { DENSITIES, THEME_TOKENS, THEMES, type Density, type ThemeName, type ThemeToken } from "./token-names.ts";
```

`apps/web/src/styles.css`:

```css
@import "tailwindcss";
@import "@pap/ui/tokens.css";
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

In `apps/web/src/build-output.int.test.ts` add, inside the existing `describe`:

```ts
  it("ships CSS without native nesting, which Safari 16.4 cannot read", () => {
    expect(css).not.toMatch(/(^|[{;\s])&[:.[\s>+~]/);
  });
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test:unit packages/ui scripts/token-classes.test.ts && pnpm test:int apps/web/src/build-output.int.test.ts`
Expected: PASS. If `p-s3` or `w-drawer-tree` compile to nothing (Tailwind not resolving a named spacing key), replace the `--spacing-*` names by explicit utilities (`@utility p-s3 { padding: var(--space-3); }` style) for each spacing utility the later tasks name in their Interfaces, and keep the test list as is.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add packages/ui apps/web/src/styles.css apps/web/src/build-output.int.test.ts scripts/tailwind-compile.ts scripts/token-classes.test.ts package.json pnpm-lock.yaml
git commit -m "feat(ui): DESIGN.md tokens with night, day and high-contrast themes and three densities"
```

---

### Task 2: Design-system gates — no native `title`, no unknown classes, the React Compiler on `@pap/ui`

Three gates make "design-system lint clean on every screen" checkable without a browser: an ESLint rule against the native `title` attribute (T3: `oxlint-plugin-t3code/rules/no-native-title-tooltip.ts`), a class-coverage test that fails on any class Tailwind cannot generate (T3: `shadcn/no-unknown-classes`; Orca: `config/oxlint-dead-classes.json`), and a React Compiler gate (R122, R128) so no component silently loses memoization.

**Files:**
- Modify: `eslint/pap-plugin.js`, `eslint/pap-plugin.test.js`, `eslint.config.js`
- Create: `scripts/class-coverage.ts`, `scripts/class-coverage.test.ts`
- Create: `apps/web/src/compiler-gate.test.ts`, `apps/web/src/compiler-pipeline.int.test.ts`

**Interfaces:**
- Consumes: `compileStyles`, `escapeClass` (Task 1).
- Produces: rule `pap/no-native-title`; `classCandidates(file: string, text: string): Candidate[]`, `unknownClasses(root: string, files?: readonly string[]): Promise<Candidate[]>` with `interface Candidate { className: string; file: string; line: number }`; the two compiler tests.

**Risks / rulings needed:** The class-coverage gate only reads `className`, `cn()` and UPPER_CASE class constants (plan convention); findings in M2-owned files go to P7 instead of being fixed here: confirm.

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
import { classCandidates, unknownClasses } from "./class-coverage.ts";
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
});
```

`apps/web/src/compiler-gate.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { transformAsync } from "@babel/core";
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
    plugins: [["babel-plugin-react-compiler", { panicThreshold: "none", logger: { logEvent: (_file: string | null, event: CompilerEvent) => events.push(event) } }]],
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
Expected: FAIL (rule and module missing). The compiler tests may already pass: that is the expected state of M1 code (R122 was applied); keep them as a gate.

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
import { compileStyles, escapeClass } from "./tailwind-compile.ts";

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
    .filter((file) => SCANNED.test(file) && !file.includes(".test.") && !file.includes("/testing/") && existsSync(join(root, file)))
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

/** Classes used in the UI code that Tailwind and tokens.css do not generate (typos, stale names, dynamic fragments). */
export async function unknownClasses(root: string, files = trackedSources(root)): Promise<Candidate[]> {
  const candidates = files.flatMap(({ file, text }) => classCandidates(file, text));
  const build = await compileStyles();
  const css = build([...new Set(candidates.map((c) => c.className))]);
  return candidates.filter((c) => !css.includes(`.${escapeClass(c.className)}`));
}
```

Add `scripts/class-coverage.ts` nothing to `knip.json` (the root workspace entry already covers `scripts/*.ts`).

- [ ] **Step 4: Run the tests and fix what they find in existing code**

Run: `pnpm test:unit eslint scripts/class-coverage.test.ts apps/web/src/compiler-gate.test.ts && pnpm test:int apps/web/src/compiler-pipeline.int.test.ts && pnpm lint`
Expected: PASS. Mutation checks (the gates must be seen failing): add a temporary `packages/ui/src/probe.tsx` component that reads `ref.current` during render → the compiler gate names it; add `className="bg-surfce"` to it → class coverage names it; add `<span title="x">` → `pnpm lint` reports `pap/no-native-title`; delete the probe. If class coverage reports classes in M1 code, fix them in files M3 owns; for M2-owned files (`apps/web/src/features/sessions/**`) record the finding in the commit body and add it to post-merge task P7 instead of editing the file. If the pipeline test fails because the Babel plugin skips files outside `apps/web`, pass the plugin an explicit include covering `packages/ui/src` (see `@rolldown/plugin-babel`'s options in its `.d.ts`) and add `expect(...)` on that option in `apps/web/src/vite-config.test.ts`.

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
  - `type ClientIssue = "storage_refused" | "boot_cache_refused" | "appearance_boot_failed" | "setting_load_failed" | "setting_save_failed" | "keybindings_invalid" | "sessions_list_failed"`, `reportClientIssue(code: ClientIssue, deps?: { warn?(line: string): void; now?(): number }): void` — one `console.warn("pap: <code>")` per code per 10 s, nothing else in the line (no user data). Every client-side `catch` in M3 code either maps the failure to something the screen shows or calls this (checklist: errors are never silent).
  - Boundary element `web-lib` (`apps/web/src/lib`): may import `web-lib`, `web-runtime`, `contracts`; `web-feature`, `web-routes`, `web-root` and `web-i18n` may import it.
  - Namespace catalogs, each `export const <ns>En = {…} as const; export const <ns>Fr: { readonly [K in keyof typeof <ns>En]: string } = {…};` — later tasks append keys under their prefix: `shell.*`, `settings.*`, `commands.*`, `gallery.*`, `ui.*` (in `shell.ts`), `server.*` (in `shell.ts`).
  - `serverText(text: string, locale?: Locale): string`.
  - `checkLiterals(root: string): Literal[]`, `literalsIn(file: string, text: string): Literal[]` with `interface Literal { file: string; line: number; text: string }`.

**Risks / rulings needed:** `IDENTICAL_IN_FR` names keys later tasks create (harmless before they exist). The catalog spreads leave M2's `sessions.*` block untouched. None.

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
  | "sessions_list_failed";

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
const SKIPPED = /\.test\.|\/testing\/|^apps\/web\/src\/gallery\//;

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
Expected: PASS. A literal found in an M2-owned file goes to P7 (commit body), not to the allowlist.

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
- Modify: `packages/ui/src/tokens.css` (reduced motion stops `animate-spin` too), `packages/ui/src/tokens.test.ts`, `packages/ui/package.json` (`lucide-react`), `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: Task 1 utilities.
- Produces:
  - `Icon({ icon: IconGlyph; size?: 14 | 16 | 20 | 28; label?: string })`, `type IconGlyph`, and the curated glyphs `IconAccount, IconAgents, IconAppearance, IconBack, IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconClose, IconCopy, IconDot, IconExport, IconHourglass, IconImport, IconInbox, IconKeyboard, IconLanguage, IconLists, IconMore, IconPlus, IconSearch, IconSettings, IconSignOut, IconSpinner, IconSplit, IconTree, IconUndo, IconWarning, IconWork`.
  - `Spinner({ label?: string })`, `ProgressBar({ value?: number | null; max?: number; label: string; tone?: "agent" | "you" })`.
  - `type FeedbackPhase = "idle" | "quiet" | "disabled" | "spinner" | "stage"`, `feedbackPhase(elapsedMs: number | null, remote: boolean): FeedbackPhase`, `usePendingFeedback(since: number | null, options?: { remote?: boolean; clock?: { now(): number } }): FeedbackPhase`, `usePendingAction(clock?): { since: number | null; run<T>(action: () => Promise<T>): Promise<T | undefined> }`.
  - `formatCost(usd: number): string`, `formatDuration(ms: number): string`, `formatDiffCounts(added: number, removed: number): string`.

**Risks / rulings needed:** lucide-react names differ across versions (renaming allowed, `Icon*` aliases fixed). A spinner turns while visible: DESIGN §7.2 "nothing repaints continuously" is read as "no idle animation"; the 1–3 s spinner of §7.3 is bounded by the action and stops under reduced motion: ruling wanted.

- [ ] **Step 1: Add lucide-react**

Run: `pnpm --filter @pap/ui add -E lucide-react && pnpm --filter @pap/web add -E lucide-react`
(The web app needs it too only for the `IconGlyph` type in props it builds; both pins must be the same version.)

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
  });
  it("writes durations as 00:07 under a minute, 3m40 above, 1h05 above an hour", () => {
    expect([formatDuration(7_000), formatDuration(220_000), formatDuration(3_900_000), formatDuration(-5)]).toEqual(["00:07", "3m40", "1h05", "00:00"]);
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
    expect(html).toContain('aria-valuenow="150"');
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
    expect(css).toContain('[data-motion="none"] .animate-spin');
    expect(css).toContain('[data-motion="system"] .animate-spin');
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
  return `$${Math.max(0, Math.round(usd * 100) / 100).toFixed(2)}`;
}

/** DESIGN.md §11: 00:07 under a minute, 3m40 under an hour, 1h05 above. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
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
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div data-slot="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-0.5 w-full bg-surface-2">
      <div className={cn("h-full", TONES[tone])} style={{ width: `${percent}%` }} />
    </div>
  );
}
```

In `packages/ui/src/tokens.css`, extend both reduced-motion selector lists that stop `.animate-indeterminate` with the same selectors for `.animate-spin` (e.g. `[data-motion="reduced"] .animate-indeterminate, [data-motion="none"] .animate-indeterminate, [data-motion="reduced"] .animate-spin, [data-motion="none"] .animate-spin { animation: none; }`, and the same inside the `prefers-reduced-motion` block).

`packages/ui/src/index.ts`: export `Icon`, `IconProps`, every name of `icons.ts`, `Spinner`, `ProgressBar`, `ProgressBarProps`, `feedbackPhase`, `usePendingFeedback`, `usePendingAction`, `FeedbackPhase`, `formatCost`, `formatDuration`, `formatDiffCounts`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit packages/ui scripts/class-coverage.test.ts apps/web/src/compiler-gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/ui apps/web/package.json package.json pnpm-lock.yaml
git commit -m "feat(ui): icons, spinner, progress bar, feedback timing and number formats"
```

---

### Task 5: Button, IconButton, Tooltip, Kbd

DESIGN.md §9.1: Button `primary` (you fill), `secondary` (outline), `ghost`, `danger` (error outline, irreversible actions only; Cancel is never `danger`), labels in mono uppercase; IconButton square with a mandatory label and tooltip. Tooltip follows Orca's STYLEGUIDE: one provider with a 400 ms delay, a tooltip names a control and never teaches, shortcut chips are separate `Kbd` elements, never baked into the label (Orca `components/ShortcutKeyCombo.tsx`).

**Files:**
- Modify: `packages/ui/src/primitives/Button.tsx`, `packages/ui/src/primitives/Button.test.tsx`, `packages/ui/src/index.ts`, `packages/ui/package.json` (`radix-ui`)
- Create: `packages/ui/src/primitives/IconButton.tsx`, `IconButton.test.tsx`, `Tooltip.tsx`, `Kbd.tsx`, `Kbd.test.tsx`
- Modify: `apps/web/src/main.tsx` (wrap the router in `TooltipProvider`)

**Interfaces:**
- Consumes: `usePendingFeedback`, `Spinner`, `Icon`, `IconGlyph` (Task 4).
- Produces:
  - `Button(props: ButtonProps)`; `ButtonProps` = button attributes without `className`/`style` + `variant?: "primary" | "secondary" | "ghost" | "danger"` (default `secondary`), `size?: "sm" | "md"`, `pendingSince?: number | null`, `remote?: boolean` (default true), `stageLabel?: string`. The M1 props keep working.
  - `IconButton({ icon: IconGlyph; label: string; shortcut?: readonly string[]; shortcutJoiner?: "" | "+"; variant?: "ghost" | "secondary"; size?: "sm" | "md"; ...button attributes without className/style/children/aria-label })`.
  - `TooltipProvider({ children })`, `Tooltip({ label: string; shortcut?: readonly string[]; shortcutJoiner?: "" | "+"; side?: "top" | "right" | "bottom" | "left"; children: ReactElement })`.
  - `Kbd({ keys: readonly string[]; joiner?: "" | "+" })`.

**Risks / rulings needed:** DESIGN gives button labels as "mono uppercase" without a size: the plan uses the HUD label (10.5 px, 600, 0.12em): ruling wanted. `sm` is a fixed 24 px row.

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

/** A shortcut chip (Orca ShortcutKeyCombo). The caller formats the keys for the platform (Task 16 `chordTokens`). */
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

`packages/ui/src/index.ts`: export `Button`, `ButtonProps`, `ButtonVariant`, `ButtonSize`, `IconButton`, `IconButtonProps`, `Tooltip`, `TooltipProvider`, `TooltipProps`, `Kbd`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit packages/ui apps/web scripts/class-coverage.test.ts`
Expected: PASS, including the M1 web tests that click buttons by their text (the DOM text is unchanged).

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/ui apps/web/src/main.tsx pnpm-lock.yaml
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

**Risks / rulings needed:** The iOS 16 px input rule (D19, T3) makes inputs larger than the density's UI size on touch screens: ruling wanted (DESIGN §5 vs pi-web ergonomics). Radix ToggleGroup's item role differs across versions (test note in Step 3).

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui/src/primitives/submit-shortcut.test.ts`:

```ts
  it("ignores the Enter that ends a Safari composition (keyCode 229)", () => {
    expect(isSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false, nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(false);
  });
```

(and give the existing calls `keyCode: 13` in `nativeEvent`).

Append to `packages/ui/src/primitives/TextField.test.tsx`:

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

DESIGN.md §9.1 rows for these components, plus §2 ("every status chip carries a word"; dashed versus solid is a cue independent of colour). Collapsible is missing from DESIGN §9.1 and Reasoning and ToolCard need it (S6, R53): ADR 0006 adds it.

**Files:**
- Create: `packages/ui/src/primitives/Chip.tsx`, `Badge.tsx`, `Avatar.tsx`, `Meter.tsx`, `Banner.tsx`, `EmptyState.tsx`, `OpenTab.tsx`, `Collapsible.tsx`, `display.test.tsx`
- Modify: `packages/ui/src/primitives/IconButton.tsx` (optional `badge`), `packages/ui/src/index.ts`
- Create: `docs/adr/0006-collapsible-primitive.md`

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

**Risks / rulings needed:** OpenTab puts its close button next to the `role="tab"` button (`tabIndex=-1`; keyboard close is the `tab.close` command, defined in Task 16 and handled in Task 21): confirm the pattern.

- [ ] **Step 1: Write the failing tests**

`packages/ui/src/primitives/display.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

`Meter.tsx`: a row with the label (`label-hud text-muted`) and `valueText` (`font-mono tabular-nums text-fg`), then a `role="meter"` bar (`h-1 w-full bg-surface-2`) with `aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={valueText} aria-label={label}` whose fill uses `const METER_TONES = { tokens: "bg-agent-fill", cost: "bg-you-fill" } as const` and an inline `width` clamped to 0–100 %.

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

/** ADR 0006 (S6, R53): the disclosure Reasoning and ToolCard need. */
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

`docs/adr/0006-collapsible-primitive.md`:

```markdown
# 0006 — Collapsible joins the primitives

Date: 2026-10-11 · Status: accepted · Deviation from: DESIGN.md §9.1 (decision 33: design changes go through an ADR)

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
git add packages/ui docs/adr/0006-collapsible-primitive.md
git commit -m "feat(ui): chips, badges, avatars, meters, banners, empty states, open tabs and collapsible"
```

---

### Task 8: Overlays — Dialog, Sheet, Drawer, Menu, Toast

Every overlay carries `--shadow-overlay`, traps focus, closes on Escape and returns focus to where it came from (T3 `finalFocus`, Orca `useModalReturnFocus`). Radix's layer stack already closes only the topmost layer (the pi-web `stacked-dialog` rule); our wrappers add the Safari composition guard: an Escape that ends a composition never closes anything. On phones, a centred dialog becomes a bottom sheet (T3 `components/ui/dialog.tsx` `bottomStickOnMobile`) and menus become sheets; a sheet lives inside `--app-viewport-height`, never at `bottom: 0` (pw: docs/agents/client-platform.md — iOS keeps the layout viewport, and `bottom: 0`, under the keyboard). Toasts sit bottom right, bottom on phones, 5 s, with Undo for reversible actions (DESIGN.md §9.1).

**Files:**
- Create: `packages/ui/src/media.ts`, `packages/ui/src/primitives/Dialog.tsx`, `Dialog.test.tsx`, `Menu.tsx`, `Menu.test.tsx`, `Toast.tsx`, `Toast.test.tsx`
- Modify: `packages/ui/src/index.ts`, `apps/web/src/main.tsx` (mount `<Toaster closeLabel={…} />`)

**Interfaces:**
- Consumes: `cancelsComposition` (Task 6), `IconButton` (Task 5).
- Produces:
  - `useMediaQuery(query: string): boolean`, `useIsPhone(): boolean` (`(max-width: 767.98px)`).
  - `type DialogVariant = "center" | "sheet" | "drawer-left" | "drawer-right" | "palette"`.
  - `Dialog({ open; onOpenChange(open: boolean): void; title: string; hideTitle?: boolean; description?: string; variant?: DialogVariant; closeLabel: string; children; footer?: ReactNode; initialFocus?: RefObject<HTMLElement | null> })`. Content carries `data-pap-modal` (the `dialogOpen` key of Task 17 reads it).
  - `type MenuItem = { readonly id: string; readonly label: string; readonly tone?: "danger"; readonly disabled?: boolean; onSelect(): void }`, `Menu({ label: string; trigger: ReactElement; items: readonly MenuItem[]; closeLabel: string })`.
  - `toast(input: { message: string; tone?: "neutral" | "error"; action?: { label: string; altText: string; run(): void } }): string` (returns the toast id), `dismissToast(id: string): void`, `Toaster({ closeLabel: string })`.

**Risks / rulings needed:** On phones every centred dialog and every menu becomes a bottom sheet (T3 `bottomStickOnMobile`): confirm. The overlay dim (`bg-bg/60`) is not in DESIGN, which only specifies the overlay shadow: ruling wanted. Radix focus return may need a settled frame in happy-dom (test note).

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
import { toast, Toaster } from "./Toast.tsx";

describe("Toast", () => {
  beforeEach(() => vi.useFakeTimers());
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

`apps/web/src/main.tsx`: render `<Toaster closeLabel={t("ui.dismiss")} />` next to the router inside `TooltipProvider`, and add to `catalog/shell.ts` the keys `"ui.dismiss": "Dismiss"` / `"Fermer"`, `"ui.close": "Close"` / `"Fermer"`.

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
- Create: `THIRD_PARTY_NOTICES.md`; modify `.prettierignore` (add `THIRD_PARTY_NOTICES.md`, hand-written legal text)

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

**Risks / rulings needed:** The Apache-2.0 compliance is S6's engineering reading (no legal review), already known to the owner. None.

- [ ] **Step 1: Write the failing tests**

Add to `packages/ui/src/ai/Message.test.tsx` (keep the M1 cases):

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

pap does not depend on the AI Elements packages and does not use the Vercel or "AI Elements" names (spike S6, ruling R53).
```

`packages/ui/src/index.ts`: export `Message`, `MessageActions`, `MessageAction`, `MessageBranch`, their prop types, `AuthorGroup`, `DaySeparator`, `RunStatusChip`, `RunStatus`, `Fence`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit packages/ui apps/web scripts/class-coverage.test.ts`
Expected: PASS (M2's `SessionScreen` tests still pass: Message's M1 props and DOM are unchanged apart from classes).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/ui THIRD_PARTY_NOTICES.md .prettierignore
git commit -m "feat(ui): message actions and branches, author groups, day separators, run status and fences"
```

---

### Task 10: Reasoning, ToolCard and the four-answer ApprovalCard

Reasoning is ported from AI Elements' `reasoning.tsx` with attribution: it opens while the model streams and closes 1 s after, unless the person toggled it; no `Shimmer` (DESIGN §1 and §7.2 forbid it). ToolCard is written from the Pi event model with AI Elements' `tool.tsx` as a reference only (S6): mono upper-case tool name in agent colour, argument summary, duration, an output body, the indeterminate bar while running, and the compact / expanded / full detail level of Settings. ApprovalCard gains DESIGN's header (`Approval · <category>`, "external content" when tainted), context, and the four answers Deny / Session / Always / Allow once, while its M1 props keep working (M2 uses them).

**Files:**
- Create: `packages/ui/src/ai/Reasoning.tsx`, `Reasoning.test.tsx`, `ToolCard.tsx`, `ToolCard.test.tsx`
- Modify: `packages/ui/src/ai/ApprovalCard.tsx`, `ApprovalCard.test.tsx`, `packages/ui/src/index.ts`

**Interfaces:**
- Consumes: `Collapsible`, `ProgressBar`, `Chip`, `Button`, `once` (Tasks 4, 5, 7).
- Produces:
  - `Reasoning({ streaming: boolean; label: string; children })` — `label` is "Thinking…" while streaming and "Thought for 14s" after, formatted by the caller.
  - `type ToolDetail = "compact" | "expanded" | "full"`, `type ToolStatus = "running" | "done" | "error"`, `ToolCard({ name: string; summary?: string; duration?: string; status: ToolStatus; detail: ToolDetail; runningLabel: string; failedLabel: string; children?: ReactNode })`.
  - `type ApprovalAnswer = "deny" | "session" | "always" | "once"`; `ApprovalCard` props: M1 (`title`, `detail`, `allowLabel`, `denyLabel`, `onAnswer(approved: boolean)`) + `category?: string`, `taintLabel?: string`, `context?: ReactNode`, `sessionLabel?: string`, `alwaysLabel?: string`, `onScopedAnswer?(answer: ApprovalAnswer): void`.

**Risks / rulings needed:** The ApprovalCard buttons move to DESIGN's order (Deny first); M2's tests select buttons by name, not order. The Session/Always answers are visual until M5 wires them: confirm M2 does not need them before the merge (if it does, M2 builds them in its feature folder and P3 converges).

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

Add to `packages/ui/src/ai/ApprovalCard.test.tsx` (keep the M1 cases, which use `allowLabel`/`denyLabel`/`onAnswer`):

```tsx
  it("offers Deny / Session / Always / Allow once in that order when scoped answers are wanted, and answers once", async () => {
    const onAnswer = vi.fn();
    const onScopedAnswer = vi.fn();
    const page = await mount(
      <ApprovalCard
        title="Approval"
        category="external write"
        taintLabel="External content"
        detail={"1 line\npush origin main"}
        allowLabel="Allow once"
        denyLabel="Deny"
        sessionLabel="Session"
        alwaysLabel="Always"
        onAnswer={onAnswer}
        onScopedAnswer={onScopedAnswer}
      />,
    );
    const labels = [...page.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Deny", "Session", "Always", "Allow once"]);
    expect(page.container.textContent).toContain("external write");
    expect(page.container.querySelector('[data-tone="ext"]')?.textContent).toBe("External content");
    await click(button(page.container, "Session"));
    await click(button(page.container, "Allow once"));
    expect(onScopedAnswer.mock.calls).toEqual([["session"]]);
    expect(onAnswer.mock.calls).toEqual([[true]]);
    await page.unmount();
  });
```

(`button` comes from the copied test helpers: add it to `packages/ui/src/testing/dom.ts` with the M1 implementation.)

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
  const [open, setOpen] = useState(detail !== "compact");
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
        <Collapsible open={open} onOpenChange={setOpen} trigger={header}>
          <pre className={cn("whitespace-pre-wrap break-words border-t border-border px-s2 py-s1 font-mono text-code text-fg", BODY_DETAIL[detail])}>{children}</pre>
        </Collapsible>
      )}
      {status === "running" ? <ProgressBar label={runningLabel} /> : null}
    </div>
  );
}
```

(Radix Collapsible does not render closed content, which is what the compact test relies on; if the pinned version renders it hidden instead, assert on `hidden` in the test rather than on absence.)

`packages/ui/src/ai/ApprovalCard.tsx`: keep the M1 structure (`splitDetail`, the lazy `once` guard, `latestOnAnswer`, the header that stays visible above the scrolling body, `role="alertdialog"` with `aria-label={props.title}` and `aria-describedby`) and change:

```tsx
export type ApprovalAnswer = "deny" | "session" | "always" | "once";

export interface ApprovalCardProps {
  readonly title: string;
  /** The complete, already escaped text of the request. Its first line is a header (size, lines, hidden characters). */
  readonly detail: string;
  readonly allowLabel: string;
  readonly denyLabel: string;
  onAnswer(approved: boolean): void;
  /** DESIGN.md §9.2 header: "Approval · <category>". */
  readonly category?: string;
  /** Shown as the dashed "external content" chip when the run is tainted (spec C §5). */
  readonly taintLabel?: string;
  /** Diff stats, trigger, tests. */
  readonly context?: ReactNode;
  readonly sessionLabel?: string;
  readonly alwaysLabel?: string;
  /** With it, the card offers Session and Always too; onAnswer still receives approved = answer !== "deny". */
  onScopedAnswer?(answer: ApprovalAnswer): void;
}
```

```tsx
  const answer = (choice: ApprovalAnswer) => {
    guard.current ??= once((value: ApprovalAnswer) => {
      setAnswered(true);
      latestOnAnswer.current(value !== "deny");
      latestOnScoped.current?.(value);
    });
    guard.current(choice);
  };
```

(`latestOnScoped` mirrors `latestOnAnswer` for `onScopedAnswer`.) The header becomes:

```tsx
      <h3 className="flex flex-wrap items-center gap-s2 label-hud text-attn">
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
        <Button variant="secondary" disabled={answered} onClick={() => answer("deny")}>
          {props.denyLabel}
        </Button>
        {props.onScopedAnswer && props.sessionLabel ? (
          <Button variant="secondary" disabled={answered} onClick={() => answer("session")}>
            {props.sessionLabel}
          </Button>
        ) : null}
        {props.onScopedAnswer && props.alwaysLabel ? (
          <Button variant="secondary" disabled={answered} onClick={() => answer("always")}>
            {props.alwaysLabel}
          </Button>
        ) : null}
        <Button variant="primary" disabled={answered} onClick={() => answer("once")}>
          {props.allowLabel}
        </Button>
      </div>
```

The M1 tests that read button order (`Allow` first) change to the DESIGN order; every other M1 assertion (header kept visible, `aria-describedby`, double click answers once, latest callback) stays.

`packages/ui/src/index.ts`: export `Reasoning`, `ReasoningProps`, `ToolCard`, `ToolCardProps`, `ToolDetail`, `ToolStatus`, `ApprovalAnswer`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit packages/ui apps/web scripts/class-coverage.test.ts apps/web/src/compiler-gate.test.ts`
Expected: PASS (the compiler gate accepts Reasoning's prop-change pattern; if it reports a bailout, keep the behaviour and restructure until it compiles, never disable the rule).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/ui
git commit -m "feat(ui): reasoning, tool card and the four-answer approval card"
```

---

### Task 11: The logo — Mark, Wordmark, favicon

DESIGN.md §6 (decision 26): the "two legs" π on a 32-unit grid, agent left in violet, you right in orange, top bar in text colour; `pap` in Manrope 800, −0.02em, lower case; tagline in mono upper case. The React Mark paints with the theme's role tones, so the day variant gets the darkened legs on its own. Static icons are SVG files (they cannot read CSS variables).

**Files:**
- Create: `packages/ui/src/brand/Mark.tsx`, `packages/ui/src/brand/Wordmark.tsx`, `packages/ui/src/brand/brand.test.tsx`
- Create: `apps/web/public/favicon.svg`, `apps/web/icons-src/favicon-tile.svg` (same content), `apps/web/icons-src/pwa-maskable.svg`, `apps/web/icons-src/apple-touch.svg`
- Modify: `apps/web/index.html`, `apps/web/src/build-output.int.test.ts`, `packages/ui/src/index.ts`

**Interfaces:**
- Produces: `Mark({ size?: number; mode?: "night" | "day"; label?: string })` (min 16 px), `Wordmark({ name: string; tagline?: string })`. Task 31 renders PNGs from `apps/web/icons-src/*.svg`.

**Risks / rulings needed:** PNG favicons and PWA icons arrive in Task 31 (they need the browser container); until then Safari 16.4 shows no tab icon (it ignores SVG favicons): acceptable interim, confirm.

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

In `apps/web/src/build-output.int.test.ts`, change the "loads only from its own origin" expectation to `expect(reference, String(reference)).toMatch(/^\/(?:assets\/|icons\/|favicon\.svg$)/);` and add:

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

DESIGN.md §13 and §14: account-scope appearance lives in "the `settings` module (account scope)"; spec C §3.2 lists the `settings` table. Keybindings ride on the same module (open question Q3 confirms the scope). New files only, plus the small hunks in shared files listed in "Coordination with M2". Values are validated by the contracts schemas before they are stored, so the server never keeps a document the client could not read back.

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
  - `THEME_ROLES`, `ThemeRoles`, `CustomTheme` (+ type), `AccountAppearance` (+ type), `KEY_NONE = "none"`, `KeybindingRule` (+ type), `KeybindingRules`, `SETTING_KEYS`, `SettingKey` (+ type), `MAX_SETTING_BYTES = 131072`, `SettingWrite` (+ type), `settingsMethods`.
  - Methods `settings.get { key } → { value: unknown | null; revision: number }` (`settings:read`, idempotent) and `settings.set { key, value } → { revision }` (`settings:operate`, mutation, errors `payload_too_large`).
  - Permission domain `settings`.
  - `SETTINGS_MIGRATIONS`, `createSettingsModule({ db, clock, logger }): { rpc: SettingsRpc }`.

**Risks / rulings needed:** Touches M2-owned files (the hunks of "Coordination with M2"): a trivial merge conflict is expected. Keybindings stored per account is open question Q3: rule before dispatch. On a read-only database (written by a newer pap) `settings.set` fails like every other write: acceptable.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AccountAppearance, KeybindingRules, SettingWrite } from "./settings.ts";

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
  it("pairs each key with its own schema", () => {
    expect(SettingWrite.safeParse({ key: "keybindings", value: [] }).success).toBe(true);
    expect(SettingWrite.safeParse({ key: "keybindings", value: base }).success).toBe(false);
    expect(SettingWrite.safeParse({ key: "theme", value: {} }).success).toBe(false);
  });
});
```

Change the mutation list in `packages/contracts/src/methods.test.ts` to include `"settings.set"` (sorted).

`apps/daemon/src/modules/settings/service.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_PERMISSIONS, PapError, type Caller } from "@pap/contracts";
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
    expect(service.set(owner("u1"), { key: "appearance", value: appearance })).toEqual({ revision: 1 });
    expect(service.set(owner("u1"), { key: "appearance", value: { ...appearance, grid: false } })).toEqual({ revision: 2 });
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: { ...appearance, grid: false }, revision: 2 });
    expect(service.get(owner("u2"), "appearance")).toEqual({ value: null, revision: 0 });
    expect(service.get(owner("u1"), "keybindings")).toEqual({ value: null, revision: 0 });
  });

  it("refuses a value over 128 KiB", () => {
    const rules = Array.from({ length: 256 }, (_, i) => ({ key: "mod+k", command: `x.${"a".repeat(120)}${i}`, when: "b".repeat(256) }));
    expect(() => service.set(owner("u1"), { key: "keybindings", value: rules })).toThrow(new PapError("payload_too_large"));
  });

  it("reads a damaged row as no setting, and logs the key, never the value", () => {
    db.run("INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ('u1', 'appearance', '{oops-secret', 3, 0)");
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: null, revision: 3 });
    expect(lines.join("\n")).toContain("settings_row_unreadable");
    expect(lines.join("\n")).not.toContain("oops-secret");
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
  it("round-trips the account appearance and refuses an invalid one", async () => {
    const client = await t.connect(await t.login());
    expect(await client.call("settings.get", { key: "appearance" })).toMatchObject({ ok: true, result: { value: null, revision: 0 } });
    const value = { mode: "night", darkTheme: "hc", lightTheme: "day", customThemes: [], uiFont: "manrope", monoFont: "system", uppercaseLabels: true, grid: false, railPosition: "left", avatarStyle: "outlined", toolDetail: "expanded" };
    expect(await client.call("settings.set", { key: "appearance", value } as never)).toMatchObject({ ok: true, result: { revision: 1 } });
    expect(await client.call("settings.get", { key: "appearance" })).toMatchObject({ ok: true, result: { value, revision: 1 } });
    expect(await client.call("settings.set", { key: "appearance", value: { ...value, darkTheme: "nope" } } as never)).toMatchObject({ ok: false, error: { code: "bad_request" } });
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

/** DESIGN.md §13.1: a custom theme edits roles, not variables. The id rule is T3's (themePalette.ts). */
export const CustomTheme = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  name: z.string().trim().min(1).max(64),
  base: z.enum(["night", "day"]),
  roles: ThemeRoles,
});
export type CustomTheme = z.infer<typeof CustomTheme>;

export const AccountAppearance = z
  .object({
    mode: z.enum(["system", "night", "day"]),
    /** "night", "hc" or the id of a custom theme on a night base. */
    darkTheme: z.string().min(1).max(48),
    /** "day" or the id of a custom theme on a day base. */
    lightTheme: z.string().min(1).max(48),
    customThemes: z.array(CustomTheme).max(16),
    uiFont: z.enum(["manrope", "system"]),
    monoFont: z.enum(["jetbrains-mono", "system"]),
    uppercaseLabels: z.boolean(),
    grid: z.boolean(),
    railPosition: z.enum(["left", "right"]),
    avatarStyle: z.enum(["outlined", "tinted", "glyph"]),
    toolDetail: z.enum(["compact", "expanded", "full"]),
  })
  .superRefine((value, ctx) => {
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

/** A user rule with this key unbinds the command's defaults (Task 16 merge rule). */
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

export const SettingWrite = z.discriminatedUnion("key", [
  z.object({ key: z.literal("appearance"), value: AccountAppearance }),
  z.object({ key: z.literal("keybindings"), value: KeybindingRules }),
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
    errors: ["payload_too_large"],
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
  /** Inserts or replaces the document; returns its new revision (1 for the first write). */
  put(ownerId: string, key: string, value: string, now: number): number;
}

export function createSettingsStore(db: Db): SettingsStore {
  return {
    get: (ownerId, key) =>
      db.get<SettingRow>("SELECT value, revision FROM settings WHERE owner_id = $ownerId AND key = $key", { ownerId, key }),
    put: (ownerId, key, value, now) =>
      db.get<{ revision: number }>(
        "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ($ownerId, $key, $value, 1, $now) " +
          "ON CONFLICT (owner_id, key) DO UPDATE SET value = excluded.value, revision = settings.revision + 1, updated_at = excluded.updated_at " +
          "RETURNING revision",
        { ownerId, key, value, now },
      )?.revision ?? 0,
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
      return { revision: deps.store.put(caller.userId, write.key, text, deps.clock.now()) };
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
Expected: PASS; `pnpm build` copies `modules/settings/migrations/*.sql` into `apps/daemon/dist` (copy-sql reads every `migrations` folder), and the smoke boots the built daemon with the new migration.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/contracts apps/daemon
git commit -m "feat(settings): account-scope settings module with appearance and keybindings documents"
```

---

### Task 13: Appearance model — defaults, resolution, custom themes, contrast

Pure code, no DOM: what the two scopes hold, how they become `<html>` attributes and variables, how a custom theme's roles become the 28 tokens (DESIGN.md §13.2), and WCAG contrast (DESIGN §12: the editor shows the ratio per role and asks below AA).

**Files:**
- Create: `apps/web/src/features/appearance/model.ts`, `model.test.ts`, `derive.ts`, `derive.test.ts`, `contrast.ts`, `contrast.test.ts`

**Interfaces:**
- Consumes: `AccountAppearance`, `CustomTheme` (Task 12); `THEME_TOKENS`, `ThemeToken`, `ThemeName`, `Density`, `DENSITIES` (Task 1).
- Produces:
  - `DEFAULT_ACCOUNT: AccountAppearance`; `interface DeviceAppearance { density: Density; uiSize: number | null; chatSize: number | null; codeSize: number | null; motion: "system" | "reduced" | "none"; chatWidth: "full" | "wide" | "narrow" }`; `DEFAULT_DEVICE`; `SIZE_RANGES = { uiSize: [12, 16], chatSize: [13, 18], codeSize: [11, 16] }`; `DEVICE_KEY = "pap.appearance.device.v1"`; `ACCOUNT_CACHE_KEY = "pap.appearance.account.v1"`.
  - `parseAccount(value: unknown): AccountAppearance`, `parseDevice(raw: string | null): DeviceAppearance`.
  - `APPEARANCE_ATTRS = ["theme","density","font-ui","font-mono","labels","grid","rail","motion","chat-width","tool-detail","avatar"] as const`, `type AppearanceAttr`.
  - `interface ResolvedAppearance { attrs: Readonly<Record<AppearanceAttr, string>>; vars: Readonly<Record<string, string>> }`, `resolveAppearance(account, device, prefersLight: boolean): ResolvedAppearance`.
  - `interface BootSide { theme: ThemeName; vars: Readonly<Record<string, string>> }`, `interface BootCache { v: 1; mode: "system" | "night" | "day"; attrs: Readonly<Record<string, string>>; vars: Readonly<Record<string, string>>; dark: BootSide; light: BootSide }`, `toBootCache(account, device): BootCache`.
  - `deriveTheme(theme: CustomTheme): Readonly<Record<ThemeToken, string>>`, `tokenVars(tokens): Record<string, string>` (`--bg` → value).
  - `contrastRatio(foreground: string, background: string, backdrop?: string): number`, `mix(a: string, b: string, t: number): string`, `ensureContrast(color: string, background: string, target: number, toward: string): string`, `interface RoleCheck { role: string; ratio: number; passes: boolean; adjusted: string | null }`, `roleChecks(theme: CustomTheme): RoleCheck[]`.

**Risks / rulings needed:** The theme mode × preset model is open question Q2: rule before dispatch. The derivation ratios (mixes of 8 %, 13 %, 22 %, 35 %, 38 %, 55 %, 58 %) are pap's own numbers for DESIGN §13.2's rules: confirm.

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
import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE, parseAccount, parseDevice, resolveAppearance, toBootCache } from "./model.ts";

const ocean = { id: "ocean", name: "Ocean", base: "night", roles: { bg: "#0E1626", surface: "#132033", text: "#E6EDF7", agent: "#38BDF8", you: "#FB923C", attn: "#EC4899", ok: "#34D399", err: "#F87171" } } as const;

describe("appearance model", () => {
  it("device settings parse fail-soft, field by field", () => {
    expect(parseDevice(null)).toEqual(DEFAULT_DEVICE);
    expect(parseDevice("{not json")).toEqual(DEFAULT_DEVICE);
    expect(parseDevice('{"density":"comfortable","uiSize":99,"motion":"none","extra":1}')).toEqual({ ...DEFAULT_DEVICE, density: "comfortable", motion: "none" });
  });

  it("an account document that does not validate reads as the defaults", () => {
    expect(parseAccount({ mode: "sepia" })).toEqual(DEFAULT_ACCOUNT);
    expect(parseAccount(null)).toEqual(DEFAULT_ACCOUNT);
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
const lower = (hex: string) => hex.toLowerCase();

/** DESIGN.md §13.2: shades, inks and day text tones derived from the eight roles. Inputs are validated hex colours. */
export function deriveTheme(theme: CustomTheme): Readonly<Record<ThemeToken, string>> {
  const r = Object.fromEntries(Object.entries(theme.roles).map(([k, v]) => [k, lower(v)])) as CustomTheme["roles"];
  const night = theme.base === "night";
  const tone = (role: string) => ensureContrast(role, r.bg, AA, r.text);
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
import { AccountAppearance } from "@pap/contracts";
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

export function parseAccount(value: unknown): AccountAppearance {
  const parsed = AccountAppearance.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_ACCOUNT;
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

Run: `pnpm test:unit apps/web/src/features/appearance`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/features/appearance
git commit -m "feat(appearance): account and device model, custom theme derivation and contrast"
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
  - `interface Frames { request(fn: () => void): number; cancel(id: number): void }`, `applyAppearance(root: HTMLElement, resolved: ResolvedAppearance, previousVars: ReadonlySet<string>, frames?: Frames): Set<string>`, `writeBootCache(storage: Pick<Storage, "setItem">, cache: BootCache): boolean` (false and `reportClientIssue("boot_cache_refused")` when storage refuses), `syncThemeColor(root: HTMLElement, doc?: Document): void`.
  - Vite plugin `appearanceBoot(): Plugin` (name `pap-appearance-boot`).

**Risks / rulings needed:** Relies on Vite 8 keeping `transformIndexHtml` tag injection and `emitFile` in `generateBundle` (pinned by the build-output test). None.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/appearance/boot-script.test.ts`:

```ts
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_KEY } from "./apply.ts";

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

  it("ignores garbage, unknown keys and throwing storage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(BOOT_KEY, "{oops");
    expect(run).not.toThrow();
    expect(warn).toHaveBeenCalledWith("pap: appearance_boot_failed");
    warn.mockRestore();
    localStorage.setItem(BOOT_KEY, JSON.stringify({ v: 1, mode: "night", attrs: { onclick: "x", density: "<b>" }, vars: { "--bg": "url(https://x.test)", "color": "red" }, dark: { theme: "evil", vars: {} }, light: { theme: "day", vars: {} } }));
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
import { applyAppearance, writeBootCache, BOOT_KEY } from "./apply.ts";
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
// only custom properties with hex or px values. ES2017, no imports; any failure leaves the defaults of tokens.css.
(function () {
  try {
    var raw = window.localStorage.getItem("pap.appearance.boot");
    if (!raw) return;
    var cache = JSON.parse(raw);
    if (!cache || cache.v !== 1) return;
    var root = document.documentElement;
    var names = ["density", "font-ui", "font-mono", "labels", "grid", "rail", "motion", "chat-width", "tool-detail", "avatar"];
    var word = /^[a-z0-9-]{1,32}$/;
    var varName = /^--[a-z0-9-]{1,40}$/;
    var varValue = /^(#[0-9a-f]{6}([0-9a-f]{2})?|\d{1,2}(\.\d{1,2})?px)$/i;
    var setVars = function (vars) {
      if (!vars || typeof vars !== "object") return;
      Object.keys(vars).forEach(function (name) {
        var value = vars[name];
        if (varName.test(name) && typeof value === "string" && varValue.test(value)) root.style.setProperty(name, value);
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
  } catch (error) {
    // The defaults of tokens.css apply; the app rewrites the cache once it starts.
    try {
      console.warn("pap: appearance_boot_failed");
    } catch (ignored) {
      // A console that throws changes nothing.
    }
  }
})();
```

`apps/web/src/features/appearance/apply.ts`:

```ts
import { reportClientIssue } from "../../lib/report.ts";
import { APPEARANCE_ATTRS, type BootCache, type ResolvedAppearance } from "./model.ts";

export const BOOT_KEY = "pap.appearance.boot";

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
Expected: PASS; the existing "has no inline script" case still passes (both scripts have a `src` under `/assets/`).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web eslint.config.js knip.json
git commit -m "feat(appearance): pre-paint boot script shipped as a hashed classic script, and the applier"
```

---

### Task 15: Appearance store, controller and account sync

The store holds both scopes; the controller applies them at start, follows the system theme, and saves account changes to the server (debounced, latest value only, stale answers ignored); the shell calls `syncAccountAppearance` once the socket is open. A daemon without `settings.get` (an older build: `unknown_method`) leaves the local values in place without a message; any other failure is shown in Settings › Appearance (Task 25 reads `accountStatus`). No client call here gets its own deadline: the runtime settles every call when the socket is declared dead (spec C §4.2 keepalive, 15 s), and a mutation that ends in `timeout`/`connection_lost` is never re-sent by itself (R105) — the next change sends the whole latest document with a new `commandId`.

**Files:**
- Create: `apps/web/src/lib/account-setting.ts`, `apps/web/src/lib/account-setting.test.ts`
- Create: `apps/web/src/features/appearance/appearance-store.ts`, `controller.ts`, `controller.test.ts`, `index.ts`
- Modify: `apps/web/src/main.tsx` (start the controller before the first render), `eslint.config.js` (`web-root` may import `web-feature`)

**Interfaces:**
- Consumes: `Runtime` (`getRuntime().rpc.call`) and `RpcError` from `apps/web/src/runtime/index.ts`; `reportClientIssue` (Task 3); Task 13 model; Task 14 applier.
- Produces:
  - `type LoadResult = { kind: "loaded"; value: unknown; revision: number } | { kind: "unsupported" } | { kind: "failed"; code: string }`, `loadSetting(rpc: Runtime["rpc"], key: SettingKey): Promise<LoadResult>` (`unsupported` for `unknown_method`).
  - `type SaveStatus = "saving" | "saved" | "error"`, `saveSetting(rpc, write: SettingWrite): Promise<unknown>`, `createSettingSaver<V>(send: (value: V) => Promise<unknown>, onStatus: (status: SaveStatus) => void, options?: { delayMs?: number; timers?: { set(fn: () => void, ms: number): number; clear(id: number): void } }): { save(value: V): void; dispose(): void }` — only the newest send may report a status.
  - `useAppearanceStore` state: `{ account: AccountAppearance; device: DeviceAppearance; accountStatus: "local" | "load-error" | SaveStatus; deviceStored: boolean; setAccount(next): void; setDevice(next): void; replaceFromServer(account): void; setAccountStatus(status): void; resetAll(): { account; device } }` (`resetAll` returns the previous values for Undo; `deviceStored` is false when localStorage refused the last device write, and Settings says the values apply to this page only).
  - `startAppearance(win?: Window): { stop(): void }`, `syncAccountAppearance(rpc: Runtime["rpc"]): Promise<void>`.
  - `features/appearance/index.ts` re-exports the public surface (store hook, start, sync, `DEFAULT_ACCOUNT`, `DEFAULT_DEVICE`, `SIZE_RANGES`, `type DeviceAppearance`, `deriveTheme`, `roleChecks`, `type RoleCheck`, `contrastRatio`).

**Risks / rulings needed:** After sign-in the server copy wins over the local cache, except for a change made while the answer travelled: confirm. Device settings are never sent to the server (DESIGN §13). None.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/account-setting.test.ts` (check the `RpcError` constructor in `apps/web/src/runtime/rpc.ts`: `new RpcError(code)`):

```ts
import { describe, expect, it, vi } from "vitest";
import { RpcError } from "../runtime/index.ts";
import { createSettingSaver, loadSetting } from "./account-setting.ts";

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
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("loadSetting", () => {
  it("tells loaded, unsupported (older daemon) and failed apart", async () => {
    expect(await loadSetting({ call: vi.fn().mockResolvedValue({ value: { a: 1 }, revision: 2 }) } as never, "appearance")).toEqual({ kind: "loaded", value: { a: 1 }, revision: 2 });
    expect(await loadSetting({ call: vi.fn().mockRejectedValue(new RpcError("unknown_method")) } as never, "appearance")).toEqual({ kind: "unsupported" });
    expect(await loadSetting({ call: vi.fn().mockRejectedValue(new RpcError("connection_lost")) } as never, "appearance")).toEqual({ kind: "failed", code: "connection_lost" });
    expect(await loadSetting({ call: vi.fn().mockRejectedValue(new Error("boom")) } as never, "appearance")).toEqual({ kind: "failed", code: "internal" });
  });
});

describe("createSettingSaver", () => {
  it("sends only the latest value after the delay and reports its status", async () => {
    const t = manualTimers();
    const send = vi.fn().mockResolvedValue({ revision: 1 });
    const statuses: string[] = [];
    const saver = createSettingSaver(send, (s) => statuses.push(s), { timers: t });
    saver.save(1);
    saver.save(2);
    expect(t.pending()).toBe(1);
    t.fire();
    await flush();
    expect(send.mock.calls).toEqual([[2]]);
    expect(statuses).toEqual(["saving", "saved"]);
  });

  it("lets only the newest send report: an older answer arriving late changes nothing", async () => {
    const t = manualTimers();
    let resolveFirst: (v: unknown) => void = () => {};
    const send = vi.fn().mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve))).mockResolvedValue({ revision: 2 });
    const statuses: string[] = [];
    const saver = createSettingSaver(send, (s) => statuses.push(s), { timers: t });
    saver.save(1);
    t.fire();
    saver.save(2);
    t.fire();
    await flush();
    resolveFirst({ revision: 1 });
    await flush();
    expect(statuses).toEqual(["saving", "saving", "saved"]);
  });

  it("reports an error and sends again only on the next change (R105)", async () => {
    const t = manualTimers();
    const send = vi.fn().mockRejectedValueOnce(new RpcError("connection_lost")).mockResolvedValue({ revision: 2 });
    const statuses: string[] = [];
    const saver = createSettingSaver(send, (s) => statuses.push(s), { timers: t });
    saver.save(1);
    t.fire();
    await flush();
    expect(t.pending()).toBe(0);
    saver.save(1);
    t.fire();
    await flush();
    expect(statuses).toEqual(["saving", "error", "saving", "saved"]);
  });

  it("dispose cancels a pending save", () => {
    const t = manualTimers();
    const saver = createSettingSaver(vi.fn(), () => {}, { timers: t });
    saver.save(1);
    saver.dispose();
    expect(t.pending()).toBe(0);
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

let listeners: Array<() => void> = [];
let light = false;
beforeEach(() => {
  localStorage.clear();
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
afterEach(() => localStorage.clear());

describe("appearance controller", () => {
  it("applies the device settings at start and follows the system theme", () => {
    useAppearanceStore.getState().setDevice({ ...DEFAULT_DEVICE, density: "mixed" });
    const controller = startAppearance(window);
    const root = document.documentElement;
    expect([root.dataset.density, root.dataset.theme]).toEqual(["mixed", "night"]);
    light = true;
    listeners.forEach((fn) => fn());
    expect(root.dataset.theme).toBe("day");
    controller.stop();
    expect(listeners).toHaveLength(0);
  });

  it("re-applies when the store changes and caches the account for the boot script", () => {
    const controller = startAppearance(window);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, mode: "day", grid: false });
    expect([document.documentElement.dataset.theme, document.documentElement.dataset.grid]).toEqual(["day", "off"]);
    expect(JSON.parse(localStorage.getItem("pap.appearance.boot") ?? "{}").mode).toBe("day");
    controller.stop();
  });

  it("takes the server's account once connected, keeps the local one when the server has none or is older", async () => {
    const controller = startAppearance(window);
    await syncAccountAppearance({ call: vi.fn().mockResolvedValue({ value: { ...DEFAULT_ACCOUNT, railPosition: "right" }, revision: 3 }) } as never);
    expect(document.documentElement.dataset.rail).toBe("right");
    await syncAccountAppearance({ call: vi.fn().mockResolvedValue({ value: null, revision: 0 }) } as never);
    expect(document.documentElement.dataset.rail).toBe("right");
    await syncAccountAppearance({ call: vi.fn().mockRejectedValue(new RpcError("unknown_method")) } as never);
    expect(useAppearanceStore.getState().accountStatus).not.toBe("load-error");
    controller.stop();
  });

  it("never overwrites a change the person made while the server answer was on its way", async () => {
    const controller = startAppearance(window);
    let answer: (v: unknown) => void = () => {};
    const pending = syncAccountAppearance({ call: vi.fn(() => new Promise((resolve) => (answer = resolve))) } as never);
    useAppearanceStore.getState().setAccount({ ...DEFAULT_ACCOUNT, grid: false });
    answer({ value: { ...DEFAULT_ACCOUNT, grid: true, railPosition: "right" }, revision: 4 });
    await pending;
    expect(useAppearanceStore.getState().account.grid).toBe(false);
    controller.stop();
  });

  it("shows a load failure as a status, not silence", async () => {
    const controller = startAppearance(window);
    await syncAccountAppearance({ call: vi.fn().mockRejectedValue(new Error("boom")) } as never);
    expect(useAppearanceStore.getState().accountStatus).toBe("load-error");
    controller.stop();
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

export type SaveStatus = "saving" | "saved" | "error";
export type LoadResult =
  | { readonly kind: "loaded"; readonly value: unknown; readonly revision: number }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly code: string };
type Timers = { set(fn: () => void, ms: number): number; clear(id: number): void };
const WINDOW_TIMERS: Timers = { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) };

/** No deadline of its own: the runtime settles every call when the socket is declared dead (spec C §4.2). */
export async function loadSetting(rpc: Runtime["rpc"], key: SettingKey): Promise<LoadResult> {
  try {
    const { value, revision } = await rpc.call("settings.get", { key });
    return { kind: "loaded", value, revision };
  } catch (error) {
    const code = error instanceof RpcError ? error.code : "internal";
    return code === "unknown_method" ? { kind: "unsupported" } : { kind: "failed", code };
  }
}

export function saveSetting(rpc: Runtime["rpc"], write: SettingWrite): Promise<unknown> {
  return rpc.call("settings.set", write);
}

/** Debounced saves: only the latest value goes out, `delayMs` after the last change, and only its answer reports. */
export function createSettingSaver<V>(
  send: (value: V) => Promise<unknown>,
  onStatus: (status: SaveStatus) => void,
  { delayMs = 400, timers = WINDOW_TIMERS }: { delayMs?: number; timers?: Timers } = {},
): { save(value: V): void; dispose(): void } {
  let timer: number | null = null;
  let generation = 0;
  return {
    save(value) {
      if (timer !== null) timers.clear(timer);
      timer = timers.set(() => {
        timer = null;
        const mine = ++generation;
        onStatus("saving");
        send(value).then(
          () => mine === generation && onStatus("saved"),
          () => mine === generation && onStatus("error"),
        );
      }, delayMs);
    },
    dispose() {
      if (timer !== null) timers.clear(timer);
      timer = null;
      generation++;
    },
  };
}
```

`apps/web/src/features/appearance/appearance-store.ts`: as described in Interfaces. Reading: `localStorage.getItem` inside `try`, a throw reads as "nothing stored" (defaults; not an error worth a line, the boot path already reported it). Writing: `setDevice` sets `deviceStored` to the result of the write; `setAccount` writes the local account cache (`ACCOUNT_CACHE_KEY`) and calls `reportClientIssue("storage_refused")` when it fails (the server copy still saves). `replaceFromServer` sets `accountStatus: "saved"`. `resetAll` returns the previous `{ account, device }` and sets both to the defaults.

```ts
import type { AccountAppearance } from "@pap/contracts";
import { create } from "zustand";
import type { SaveStatus } from "../../lib/account-setting.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { ACCOUNT_CACHE_KEY, DEFAULT_ACCOUNT, DEFAULT_DEVICE, DEVICE_KEY, parseAccount, parseDevice, type DeviceAppearance } from "./model.ts";

interface AppearanceState {
  readonly account: AccountAppearance;
  readonly device: DeviceAppearance;
  readonly accountStatus: "local" | "load-error" | SaveStatus;
  readonly deviceStored: boolean;
  setAccount(next: AccountAppearance): void;
  setDevice(next: DeviceAppearance): void;
  replaceFromServer(account: AccountAppearance): void;
  setAccountStatus(status: AppearanceState["accountStatus"]): void;
  resetAll(): { account: AccountAppearance; device: DeviceAppearance };
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
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
    return raw === null ? DEFAULT_ACCOUNT : parseAccount(JSON.parse(raw));
  } catch {
    return DEFAULT_ACCOUNT;
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
    set({ account, accountStatus: "saved" });
  },
  setAccountStatus: (accountStatus) => set({ accountStatus }),
  resetAll: () => {
    const previous = { account: get().account, device: get().device };
    get().setAccount(DEFAULT_ACCOUNT);
    get().setDevice(DEFAULT_DEVICE);
    return previous;
  },
}));
```

`apps/web/src/features/appearance/controller.ts`:

```ts
import type { AccountAppearance } from "@pap/contracts";
import { createSettingSaver, loadSetting, saveSetting } from "../../lib/account-setting.ts";
import type { Runtime } from "../../runtime/index.ts";
import { applyAppearance, syncThemeColor, writeBootCache } from "./apply.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { parseAccount, resolveAppearance, toBootCache } from "./model.ts";

const LIGHT = "(prefers-color-scheme: light)";
let active: { stop(): void } | null = null;
let saver: ReturnType<typeof createSettingSaver<AccountAppearance>> | null = null;
let fromServer = false;

/** Applies the appearance now and on every change of the store or of the system theme. Once, before the first render. */
export function startAppearance(win: Window = window): { stop(): void } {
  active?.stop();
  const root = win.document.documentElement;
  let vars = new Set<string>();
  const media = typeof win.matchMedia === "function" ? win.matchMedia(LIGHT) : null;
  const apply = () => {
    const { account, device } = useAppearanceStore.getState();
    vars = applyAppearance(root, resolveAppearance(account, device, media?.matches ?? false), vars);
    writeBootCache(win.localStorage, toBootCache(account, device));
    syncThemeColor(root, win.document);
  };
  apply();
  media?.addEventListener("change", apply);
  const unsubscribe = useAppearanceStore.subscribe((state, previous) => {
    if (state.account === previous.account && state.device === previous.device) return;
    apply();
    if (state.account !== previous.account && !fromServer) saver?.save(state.account);
  });
  active = {
    stop() {
      media?.removeEventListener("change", apply);
      unsubscribe();
      saver?.dispose();
      active = null;
    },
  };
  return active;
}

/** Once the socket is open: take the server's account document, then save later account changes to it. */
export async function syncAccountAppearance(rpc: Runtime["rpc"]): Promise<void> {
  saver?.dispose();
  saver = createSettingSaver<AccountAppearance>(
    (value) => saveSetting(rpc, { key: "appearance", value }),
    (status) => useAppearanceStore.getState().setAccountStatus(status),
  );
  const before = useAppearanceStore.getState().account;
  const loaded = await loadSetting(rpc, "appearance");
  if (loaded.kind === "failed") {
    useAppearanceStore.getState().setAccountStatus("load-error");
    return;
  }
  // A change made while the answer travelled is newer than the server's copy: keep it (the saver sends it).
  if (loaded.kind !== "loaded" || loaded.value === null || useAppearanceStore.getState().account !== before) return;
  fromServer = true;
  try {
    useAppearanceStore.getState().replaceFromServer(parseAccount(loaded.value));
  } finally {
    fromServer = false;
  }
}

// A hot update replaces this module: the old controller must not keep its listeners (R125).
if (import.meta.hot) import.meta.hot.dispose(() => active?.stop());
```

`apps/web/src/main.tsx`: after the locale lines and before `createRoot`, call `startAppearance();` (from `./features/appearance/index.ts`). In `eslint.config.js`, add `"web-feature"` to the allow list of `web-root` (`web-lib` was created in Task 3).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint && pnpm typecheck`
Expected: PASS. Mutation checks: remove the generation guard → "only the newest send may report" fails; remove the `account !== before` guard → "never overwrites a change" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web eslint.config.js
git commit -m "feat(appearance): store, controller and debounced account sync"
```

---
# Phase 5 — Commands: keybindings, dispatcher, palette core

### Task 16: Keybinding core — chords, `when` clauses, merge, conflicts, labels

Pure functions, no DOM. The format is T3's (`packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`): a JSON array of `{ key, command, when? }`, later rules win, user rules replace the defaults of the commands they name (T3 `mergeWithDefaultKeybindings`, shared 451-469), the `when` grammar is identifiers with `!`, `&&`, `||` and parentheses (shared 282-414, depth ≤ 64, unknown identifiers are false). Matching is layout-aware the way Orca does it (`src/shared/keybindings/matching-key.ts`, `input.ts`): the layout key first, the physical key for digits and punctuation, and for letters only when the layout key is unusable (dead key, a non-Latin letter under Ctrl/Cmd, a macOS Option composition). AltGr never matches (pw: `hooks/useKeyboardShortcuts.ts`, T3 shared 100-113); composition keys never match (T3 + Orca bail-outs). Labels follow pw `lib/shortcut-label.ts`: `⌃⌥⇧⌘` glyphs joined without a separator on Apple platforms, `Ctrl+Alt+N` elsewhere. Browser-reserved chords are flagged (Orca's `ignoredActionIds` idea for OS-reserved chords; Review Focus 4).

**Files:**
- Create: `apps/web/src/features/commands/keys.ts`, `keys.test.ts`, `when.ts`, `when.test.ts`, `defaults.ts`, `resolve.ts`, `resolve.test.ts`, `labels.ts`, `labels.test.ts`
- Modify: `apps/web/src/i18n/catalog/commands.ts` (command titles, key names)

**Interfaces:**
- Consumes: `KeybindingRule`, `KEY_NONE` (Task 12); `cancelsComposition` (Task 6).
- Produces:
  - `type Platform = "mac" | "other"`; `interface Chord { mod; ctrl; meta; alt; shift: boolean; key: string }`; `parseChord(text: string): Chord | null`; `interface KeyInput { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number; getModifierState?(name: string): boolean }`; `keyCandidates(event: KeyInput, platform): string[]`; `matchesChord(chord, event, platform): boolean`; `chordId(chord, platform): string` (canonical `ctrl+alt+shift+meta+<key>`); `chordFromEvent(event, platform): string | null` (for the recorder; `mod` on the platform's own modifier).
  - `type WhenNode = { type: "id"; name: string } | { type: "not"; node: WhenNode } | { type: "and" | "or"; left: WhenNode; right: WhenNode }`; `type WhenError = { error: "empty" | "unexpected" | "unclosed" | "too_deep"; at: number }`; `parseWhen(text: string): WhenNode | WhenError`; `evaluateWhen(node, context: Readonly<Record<string, boolean>>): boolean`; `mentions(node, name: string): boolean`.
  - `type CommandGroup = "navigation" | "tabs" | "panes" | "session" | "agents" | "app"`; `interface CommandSpec { id: string; titleKey: MessageKey; titleVars?: Record<string, number>; group: CommandGroup }`; `COMMANDS: readonly CommandSpec[]`; `DEFAULT_KEYBINDINGS: readonly KeybindingRule[]`; `KNOWN_COMMANDS: ReadonlySet<string>`; `CONTEXT_KEYS = ["editableFocus", "dialogOpen", "paletteOpen", "sessionFocus", "mobile"] as const`.
  - `interface ResolvedRule { chord: Chord; command: string; when: WhenNode | null; source: "default" | "user"; index: number }`; `interface RuleIssue { index: number; problem: "key" | "when" | "command" }`; `mergeWithDefaults(defaults, user, known): { rules: ResolvedRule[]; issues: RuleIssue[] }`; `matchingCommands(event, rules, context, platform): string[]` (last matching rule first, de-duplicated); `conflictsOf(rules, platform): Map<number, string[]>`; `isReserved(chord, platform): boolean`.
  - `type KeyNames = Readonly<Record<"ctrl" | "alt" | "shift" | "meta" | "escape" | "enter" | "space" | "tab" | "backspace" | "delete" | "up" | "down" | "left" | "right" | "home" | "end" | "pageup" | "pagedown", string>>`; `detectPlatform(nav?: { platform?: string; userAgent?: string }): Platform`; `chordTokens(chord, platform, names: KeyNames): string[]`; `chordJoiner(platform): "" | "+"`; `ariaKeyShortcuts(chord, platform): string`.

**Risks / rulings needed:** (a) Default chords chosen to avoid what browsers keep: tab switching is `Alt+Shift+←/→` and closing a tab `Alt+W` (both off inside text fields), because `Ctrl+Tab`, `Ctrl+PgUp/PgDn` and `Ctrl+W` never reach a page: ruling wanted on these three defaults. (b) A shifted symbol (`?`) matches whatever Shift state the layout needs: confirm. (c) On Windows, `Ctrl+Alt` is AltGr, so `Ctrl+Alt+1..9` and `Ctrl+Alt+N` do not fire there (pi-web's accepted trade-off): confirm. (d) A bare printable key (no Ctrl/Meta/Alt) never fires while a text field has focus unless its `when` names `editableFocus` (Orca `fileSearchClaimsTextKey`): confirm.

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

  it("lets a shifted symbol match whatever Shift the layout needs", () => {
    expect(matchesChord(parseChord("?") as never, ev({ key: "?", code: "Slash", shiftKey: true }), "other")).toBe(true);
    expect(matchesChord(parseChord("?") as never, ev({ key: "?", code: "KeyM", shiftKey: true }), "other")).toBe(true);
  });

  it("gives one identity per platform and records chords with mod", () => {
    expect(chordId(parseChord("mod+shift+k") as never, "mac")).toBe("shift+meta+k");
    expect(chordId(parseChord("ctrl+shift+k") as never, "other")).toBe(chordId(parseChord("mod+shift+k") as never, "other"));
    expect(chordFromEvent(ev({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }), "other")).toBe("mod+shift+p");
    expect(chordFromEvent(ev({ key: "Control", code: "ControlLeft", ctrlKey: true }), "other")).toBeNull();
  });
});
```

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
  it("never fires a bare printable key in a text field unless its clause names editableFocus", () => {
    const loose = mergeWithDefaults([], [{ key: "?", command: "shortcuts.help" }], known).rules;
    expect(matchingCommands(ev({ key: "?", code: "Slash", shiftKey: true }), loose, { editableFocus: true }, "other")).toEqual([]);
    expect(matchingCommands(ev({ key: "?", code: "Slash", shiftKey: true }), loose, { editableFocus: false }, "other")).toEqual(["shortcuts.help"]);
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
    expect(isReserved(parseChord("mod+k") as never, "other")).toBe(false);
  });
});
```

`apps/web/src/features/commands/labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { ariaKeyShortcuts, chordJoiner, chordTokens, detectPlatform, type KeyNames } from "./labels.ts";

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

/** The keys an event can stand for. Empty during a composition, for an input method's Process key, and for AltGr. */
export function keyCandidates(event: KeyInput, platform: Platform): string[] {
  if (cancelsComposition(event) || event.key === "Process") return [];
  if (platform === "other" && event.getModifierState?.("AltGraph") === true) return [];
  const layout = event.key === " " ? " " : event.key.toLowerCase();
  const physical = codeKey(event.code);
  const unusable = layout === "" || layout === "dead" || layout === "unidentified";
  const nonLatinUnderCommand = /^\p{L}$/u.test(layout) && !/^[a-z]$/.test(layout) && (event.ctrlKey || event.metaKey);
  const macComposed = platform === "mac" && event.altKey && isPrintable(layout) && !/^[\x20-\x7e]$/.test(layout);
  const layoutUsable = !unusable && !nonLatinUnderCommand && !macComposed;
  const out = new Set<string>();
  if (layoutUsable) out.add(layout);
  if (physical !== null && (!/^[a-z]$/.test(physical) || !layoutUsable)) out.add(physical);
  return [...out];
}

const SHIFTED_SYMBOL = /^[^a-z0-9\s]$/u;

export function matchesChord(chord: Chord, event: KeyInput, platform: Platform): boolean {
  if (!keyCandidates(event, platform).includes(chord.key)) return false;
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.altKey !== chord.alt) return false;
  // The Shift of a symbol such as "?" belongs to the layout, not to the chord.
  const symbol = !chord.shift && SHIFTED_SYMBOL.test(chord.key);
  return symbol || event.shiftKey === chord.shift;
}

/** Canonical identity on one platform: conflicts and reserved chords compare these. */
export function chordId(chord: Chord, platform: Platform): string {
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  return [ctrl && "ctrl", chord.alt && "alt", chord.shift && "shift", meta && "meta", chord.key].filter(Boolean).join("+");
}

/** For the shortcut recorder: the chord an event stands for, written with `mod`; null for a lone modifier. */
export function chordFromEvent(event: KeyInput, platform: Platform): string | null {
  const [key] = keyCandidates(event, platform);
  if (key === undefined || MODIFIER_KEYS.has(event.key.toLowerCase())) return null;
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  const parts = [mod && "mod", (platform === "mac" ? event.ctrlKey : event.metaKey) && (platform === "mac" ? "ctrl" : "meta"), event.altKey && "alt", event.shiftKey && "shift", key === " " ? "space" : key];
  return parts.filter(Boolean).join("+");
}
```

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
export const CONTEXT_KEYS = ["editableFocus", "dialogOpen", "paletteOpen", "sessionFocus", "mobile"] as const;

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

// pi-web's shortcuts (spec C §7.3) plus the shell's; chords browsers keep are avoided (Review Focus 4).
export const DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [
  { key: "mod+k", command: "palette.toggle" },
  { key: "mod+b", command: "drawer.tree.toggle", when: "!dialogOpen" },
  { key: "mod+,", command: "settings.open", when: "!dialogOpen" },
  { key: "?", command: "shortcuts.help", when: "!editableFocus && !dialogOpen" },
  { key: "ctrl+alt+n", command: "session.new", when: "!dialogOpen" },
  { key: "escape", command: "session.stop", when: "sessionFocus && !dialogOpen && !paletteOpen" },
  { key: "alt+shift+arrowright", command: "tab.next", when: "!editableFocus && !dialogOpen" },
  { key: "alt+shift+arrowleft", command: "tab.prev", when: "!editableFocus && !dialogOpen" },
  { key: "alt+w", command: "tab.close", when: "!editableFocus && !dialogOpen" },
  { key: "mod+\\", command: "pane.split", when: "!dialogOpen && !mobile" },
  { key: "alt+arrowdown", command: "agent.nextUnread", when: "!dialogOpen" },
  { key: "alt+arrowup", command: "agent.prevUnread", when: "!dialogOpen" },
  ...Array.from({ length: 9 }, (_, i) => ({ key: `ctrl+alt+${i + 1}`, command: `agent.goto.${i + 1}`, when: "!dialogOpen" })),
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

`labels.ts`:

```ts
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

/** ARIA's aria-keyshortcuts form ("Control+K", "Meta+K"). */
export function ariaKeyShortcuts(chord: Chord, platform: Platform): string {
  const ctrl = chord.ctrl || (chord.mod && platform === "other");
  const meta = chord.meta || (chord.mod && platform === "mac");
  const key = chord.key === " " ? "Space" : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key.replace(/^arrow/, "Arrow").replace(/^./, (c) => c.toUpperCase());
  return [ctrl && "Control", chord.alt && "Alt", chord.shift && "Shift", meta && "Meta", key].filter(Boolean).join("+");
}
```

Add the key names to `catalog/commands.ts` (`commands.key.ctrl` "Ctrl"/"Ctrl", `commands.key.shift` "Shift"/"Maj", `commands.key.escape` "Esc"/"Échap", `commands.key.enter` "Enter"/"Entrée", `commands.key.space` "Space"/"Espace", `commands.key.delete` "Del"/"Suppr", `commands.key.up` "Up"/"Haut"…, with the keys that are the same word in French added to `IDENTICAL_IN_FR`), and a helper `keyNames(t: Translate): KeyNames` in `labels.ts` that builds the record from those keys.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web/src/features/commands apps/web/src/i18n`
Expected: PASS. Mutation checks: drop the `layoutUsable` condition on letters → "AZERTY A is not Q" fails; drop the bare-printable guard → "never fires a bare printable key in a text field" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/features/commands apps/web/src/i18n
git commit -m "feat(commands): keybinding chords, when clauses, merge, conflicts and labels"
```

---

### Task 17: Command registry, key dispatcher, user keybindings, shortcuts help

One capture-phase `keydown` listener on `window` (Orca `src/renderer/src/app-shell/use-global-keybindings.ts`: one long-lived listener, bail-outs first) resolves the event to candidate commands; a registry maps each command to the handler of whoever mounted it (Orca `app-command-handlers.ts`: a handler returns false to decline, so an unclaimed chord falls through to the browser and the focused element). The same registry runs commands from the palette. User rules load from and save to the account `keybindings` document (Task 12) exactly like the appearance. `?` opens the shortcuts help (pw `components/ShortcutsDialog.tsx`), built from the effective rules, so it is never out of date.

**Files:**
- Create: `apps/web/src/features/commands/registry.ts`, `registry.test.ts`, `context.ts`, `dispatcher.ts`, `dispatcher.test.ts`, `use-command.ts`, `keybindings-store.ts`, `keybindings-store.test.ts`, `ShortcutsHelp.tsx`, `ShortcutsHelp.test.tsx`, `index.ts`
- Modify: `apps/web/src/i18n/catalog/commands.ts`

**Interfaces:**
- Consumes: Task 16; `loadSetting`, `saveSetting`, `createSettingSaver`, `reportClientIssue` (Tasks 3, 15); `Dialog`, `Kbd` (Tasks 5, 8).
- Produces:
  - `type CommandHandler = () => boolean | void` (false = declined); `registerCommand(id: string, handler: CommandHandler): () => void` (a stack per id, the latest registration answers; the returned function removes exactly that registration); `runCommand(id: string): boolean`; `hasCommand(id: string): boolean`; `onRegistryChange(listener): () => void`.
  - `useCommand(id: string, handler: CommandHandler, enabled?: boolean): void` (latest-callback ref, registered in an effect).
  - `readContext(doc: Document, shell: { mobile: boolean }): Record<string, boolean>` (keys of `CONTEXT_KEYS`: `editableFocus` = focus inside `input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]` (T3 `lib/editableFocus.ts`); `dialogOpen` = a `[data-pap-modal][data-state="open"]` exists; `paletteOpen` = `[data-command-palette]` exists; `sessionFocus` = focus inside `[data-pane-kind="session"]`; `mobile` from the shell).
  - `installDispatcher(deps: { win: Window; platform: Platform; rules(): readonly ResolvedRule[]; shell(): { mobile: boolean } }): () => void`.
  - `useKeybindingsStore` state `{ user: KeybindingRule[]; rules: ResolvedRule[]; issues: RuleIssue[]; status: "local" | "load-error" | SaveStatus; setUser(next: KeybindingRule[]): void }`; `syncKeybindings(rpc: Runtime["rpc"]): Promise<void>`.
  - `ShortcutsHelp({ open: boolean; onOpenChange(open: boolean): void; platform: Platform })`.
  - `features/commands/index.ts` re-exports all public names of Tasks 16–17 (and Task 22, 27 add theirs).

**Risks / rulings needed:** (a) The dispatcher ignores auto-repeat for every command (T3 `if (event.repeat) return`): confirm, or name commands that may repeat. (b) Before M2's session screen registers `session.stop` (post-merge P3), Escape is unclaimed and keeps its browser meaning: acceptable interim. None else.

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

const known = new Set(["palette.toggle", "shortcuts.help", "drawer.tree.toggle"]);
const { rules } = mergeWithDefaults(
  [
    { key: "mod+k", command: "palette.toggle" },
    { key: "mod+b", command: "drawer.tree.toggle", when: "!dialogOpen" },
    { key: "?", command: "shortcuts.help", when: "!editableFocus && !dialogOpen" },
  ],
  [],
  known,
);
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

let stop: () => void;
let cleanup: Array<() => void> = [];
beforeEach(() => {
  stop = installDispatcher({ win: window, platform: "other", rules: () => rules, shell: () => ({ mobile: false }) });
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
    stop = installDispatcher({ win: window, platform: "other", rules: () => rules, shell: () => ({ mobile: false }) });
    press({ key: "k", code: "KeyK", ctrlKey: true });
    window.removeEventListener("keydown", first, { capture: true });
    expect(handler).not.toHaveBeenCalled();
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

`keybindings-store.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { syncKeybindings, useKeybindingsStore } from "./keybindings-store.ts";

const report = vi.hoisted(() => ({ reportClientIssue: vi.fn() }));
vi.mock("../../lib/report.ts", () => report);

beforeEach(() => {
  vi.useFakeTimers(); // the saver's 400 ms debounce never fires on its own here
  localStorage.clear();
  useKeybindingsStore.getState().setUser([]);
  report.reportClientIssue.mockClear();
});
afterEach(() => vi.useRealTimers());

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

  it("takes valid server rules and keeps its own on an invalid document, an old daemon or a change made meanwhile", async () => {
    await syncKeybindings({ call: vi.fn().mockResolvedValue({ value: [{ key: "alt+p", command: "palette.toggle" }], revision: 1 }) } as never);
    expect(useKeybindingsStore.getState().user).toEqual([{ key: "alt+p", command: "palette.toggle" }]);

    const tooMany = Array.from({ length: 300 }, () => ({ key: "mod+k", command: "palette.toggle" }));
    await syncKeybindings({ call: vi.fn().mockResolvedValue({ value: tooMany, revision: 2 }) } as never);
    expect([useKeybindingsStore.getState().user.length, useKeybindingsStore.getState().status]).toEqual([1, "load-error"]);

    await syncKeybindings({ call: vi.fn().mockRejectedValue(new RpcError("unknown_method")) } as never);
    expect(useKeybindingsStore.getState().user).toHaveLength(1);

    let answer: (value: unknown) => void = () => {};
    const pending = syncKeybindings({ call: vi.fn(() => new Promise((resolve) => (answer = resolve))) } as never);
    useKeybindingsStore.getState().setUser([{ key: "alt+o", command: "palette.toggle" }]);
    answer({ value: [{ key: "alt+q", command: "palette.toggle" }], revision: 3 });
    await pending;
    expect(useKeybindingsStore.getState().user).toEqual([{ key: "alt+o", command: "palette.toggle" }]);
  });
});
```

`ShortcutsHelp.test.tsx`: opened, it lists each command that has an effective chord with its title and its `Kbd` tokens (`Ctrl` `K` for `palette.toggle` on "other"), grouped under `commands.group.*` headings; a command whose only rule is unbound (`none`) is not listed.

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

`dispatcher.ts`:

```ts
import { cancelsComposition } from "@pap/ui";
import { readContext } from "./context.ts";
import type { Platform } from "./keys.ts";
import { runCommand } from "./registry.ts";
import { matchingCommands, type ResolvedRule } from "./resolve.ts";

export interface DispatcherDeps {
  readonly win: Window;
  readonly platform: Platform;
  rules(): readonly ResolvedRule[];
  shell(): { readonly mobile: boolean };
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

`context.ts`, `use-command.ts`, `keybindings-store.ts`, `ShortcutsHelp.tsx`: as their Interfaces say. `keybindings-store.ts` mirrors Task 15's store and controller in one file (keybindings have no device scope): `setUser` writes the local cache (`pap.keybindings.v1`), recomputes `{ rules, issues } = mergeWithDefaults(DEFAULT_KEYBINDINGS, user, KNOWN_COMMANDS)`, reports `keybindings_invalid` when `issues` is not empty, and schedules a save through `createSettingSaver` once `syncKeybindings` has run; `syncKeybindings` validates the server value with `KeybindingRules.safeParse` before replacing anything. `useCommand` keeps the latest handler in a ref updated in an effect and registers `() => latest.current()` while `enabled`.

`ShortcutsHelp` lists `COMMANDS` grouped by `group`, each with `chordTokens` of its last effective rule and `chordJoiner(platform)`, in a `Dialog` titled `t("commands.help.title")` ("Keyboard shortcuts" / "Raccourcis clavier").

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web/src/features/commands && pnpm lint`
Expected: PASS. Mutation checks: remove the `event.repeat` bail-out → the auto-repeat case fails; remove the `defaultPrevented` bail-out → "leaves a key another handler already took" fails.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web/src/features/commands apps/web/src/i18n
git commit -m "feat(commands): command registry, one key dispatcher, account keybindings and shortcuts help"
```

---
# Phase 6 — The shell (decision 25)

### Task 18: Workspace model — open items, split panes, persistence, URL mapping

DESIGN.md §8: the tabs bar shows what is open (closing a tab deletes nothing); panes split with a 320 px minimum; the layout is remembered (per lane once lanes exist, M9; per open item until then). The model is Orca's (`src/shared/tab-types.ts`, `src/shared/workspace-layout/tab-group-layout-tree.ts`): items addressed by a stable key, split ratios part of the persisted model, an unchanged ratio returns the same object so no subscriber wakes. M3 needs one split per tab (two panes); the persisted shape is versioned (`pap.workspace.v1`) so M8/M9 can grow it into Orca's binary tree with a migration.

**Files:**
- Create: `apps/web/src/features/workspace/model.ts`, `model.test.ts`, `item-path.ts`, `item-path.test.ts`, `persist.ts`, `persist.test.ts`, `workspace-store.ts`, `index.ts`

**Interfaces:**
- Produces:
  - `SETTINGS_SECTIONS = ["appearance", "shortcuts", "language", "account"] as const`, `type SettingsSection`.
  - `type ItemRef = { kind: "home" } | { kind: "session"; id: string } | { kind: "settings"; section: SettingsSection } | { kind: "dev-ui" }`; `interface Split { item: ItemRef; ratio: number }`; `interface Tab { key: string; item: ItemRef; split: Split | null }`; `interface Workspace { tabs: readonly Tab[]; active: string | null }`; `EMPTY_WORKSPACE`; `MAX_TABS = 24`; `MIN_RATIO = 0.15`; `MAX_RATIO = 0.85`.
  - `itemKey(item): string` (`home`, `session:<id>`, `settings` — one settings tab whatever the section —, `dev-ui`); `openItem(ws, item)`; `closeTab(ws, key)`; `cycleTab(ws, step: 1 | -1)`; `splitTab(ws, key, item)`; `unsplitTab(ws, key)`; `setSplitRatio(ws, key, ratio)`; `activeTab(ws): Tab | null`.
  - `itemFromPath(pathname: string, devUi: boolean): ItemRef | null`; `pathOfItem(item): string`.
  - `WORKSPACE_KEY = "pap.workspace.v1"`; `parseWorkspace(raw: string | null, devUi: boolean): Workspace`; `serializeWorkspace(ws): string`.
  - `useWorkspaceStore` state `{ ws: Workspace; open(item): void; close(key): void; cycle(step): void; split(key, item): void; unsplit(key): void; setRatio(key, ratio): void }` (persists every change; a refused write calls `reportClientIssue("storage_refused")`).

**Risks / rulings needed:** (a) At 24 open tabs, opening another closes the oldest inactive tab (nothing is deleted, the item is still in the drawer and ⌘K): confirm, or rule a refusal instead. (b) Only the active tab is mounted; switching tabs remounts the session screen (its state lives in M2's store): confirm. (c) The layout is remembered per open item until lanes exist (DESIGN says per lane): confirm.

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

### Task 19: Router and shell skeleton — rail, top bar, pane host, not found, connection banners

The auth gate stays in `RootLayout`; once signed in it renders `AppShell` instead of M1's `AccountBar` + `Outlet`. The URL is the single source of the active item: UI actions navigate, and the shell opens or activates the tab the path names (pw: URL state in `components/AppShell.tsx`). TanStack routes stay declared so M2's `Link to="/s/$sessionId"` and `navigate({ to: "/" })` keep type-checking; their components render nothing and the shell renders the panes. An unknown path shows a not-found screen and opens no tab (Review Focus 5) — M1 redirected it home.

**Files:**
- Modify: `apps/web/src/routes/router.tsx`, `apps/web/src/routes/RootLayout.tsx`, `apps/web/src/routes/RootLayout.test.tsx`
- Create: `apps/web/src/routes/shell/AppShell.tsx`, `AppShell.test.tsx`, `Rail.tsx`, `TopBar.tsx`, `PaneHost.tsx`, `pane-renderers.tsx`, `NotFound.tsx`, `ConnectionBanner.tsx`, `sessions-cache.ts`, `sessions-cache.test.ts`, `use-shell-effects.ts`
- Create: `apps/web/src/testing/shell-bed.tsx`
- Delete: `apps/web/src/features/auth/AccountBar.tsx`, `AccountBar.test.tsx` (the account controls move to the rail menu here and to Settings in Task 24)
- Modify: `apps/web/src/i18n/catalog/shell.ts`

**Interfaces:**
- Consumes: `getRuntime`, `useConnectionState` (M1 runtime); `logout` (`features/auth/auth-api.ts`); `SessionListScreen`, `SessionScreen` (M2-owned, used as they exist on main); Tasks 4–11 primitives; Task 15 `syncAccountAppearance`; Task 17 `installDispatcher`, `syncKeybindings`, `useKeybindingsStore`, `detectPlatform`; Task 18 workspace.
- Produces:
  - `buildRouteTree(Root: () => ReactNode)` (the five routes under a root component), `routeTree = buildRouteTree(RootLayout)` and `router`; routes `/`, `/s/$sessionId`, `/settings`, `/settings/$section`, `/dev/ui`.
  - `AppShell({ username: string | null; passkeysAvailable: boolean; onSignedOut(): void })`.
  - `PANE_RENDERERS: { [K in ItemRef["kind"]]: (item: Extract<ItemRef, { kind: K }>) => ReactNode }` with `home` → `<SessionListScreen />`, `session` → `<SessionScreen key={id} sessionId={id} />`, `settings` and `dev-ui` → `<NotFound />` until Tasks 24 and 28 replace them; `PaneHost({ tab: Tab | null })` renders `<section data-pane-kind={kind} aria-label={title}>` around the renderer.
  - `useSessionsCache` state `{ sessions: readonly SessionSummary[]; status: "idle" | "loading" | "loaded" | "error"; refresh(rpc: Runtime["rpc"]): Promise<void> }` (sorted by `updatedAt` desc, capped at 500; a refresh while one runs returns the same promise, so two answers never race; `refresh` never rejects — a failure sets `status: "error"` and keeps the list).
  - `itemTitle(item: ItemRef, sessions: readonly SessionSummary[], t: Translate): string` (session → basename of its cwd, else `shell.tab.session`; home → `shell.tab.home`; settings → `shell.tab.settings`; dev-ui → `gallery.title`).
  - `navigateTo(navigate, item)` helper (`pathOfItem`).
  - `renderShell(path: string, options?: { username?: string; onSignedOut?(): void; phone?: boolean }): Promise<Mounted & { router: AnyRouter }>` in `testing/shell-bed.tsx`: a memory-history router over `buildRouteTree(() => <AppShell … />)` (no auth gate), inside `TooltipProvider` and `Toaster`; `phone` stubs `window.matchMedia` for the phone query.

**Risks / rulings needed:** (a) Before M2's drafts exist, the reconnect banner says only "Reconnecting…" (DESIGN 12 adds "your drafts stay on this device"; P3 adds it once true): confirm. (b) The project switcher of the top bar is deferred to M4 (no projects yet): confirm. (c) The rail shows the logo, Settings and the account menu; agent avatars arrive in M11: confirm. (d) M2 may restyle or rename `SessionListScreen`/`SessionScreen`; the shell imports them by these names (merge note).

- [ ] **Step 1: Write the failing tests**

`AppShell.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, press, settle } from "../../testing/dom.ts";
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
});
```

(The not-found heading is the `EmptyState`'s `h2`. The keyboard path through the account menu relies on Radix moving focus to the first enabled item, "Sign out", after the disabled username row; if the pinned Radix version focuses the content instead, press `ArrowDown` once before `Enter`.)

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

Update `RootLayout.test.tsx`: mock `./shell/AppShell.tsx` with a stub rendering `<p data-screen="shell">pap · {username}</p>`; the existing gate cases keep their assertions (`pap · ana` now comes from the stub), the passkey case checks the stub's props instead of the deleted AccountBar.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/routes`
Expected: FAIL.

- [ ] **Step 3: Implement**

`router.tsx`:

```tsx
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { RootLayout } from "./RootLayout.tsx";

// The routes name the URLs (typed links, M2's Link to="/s/$sessionId"); AppShell renders the panes from the path.
const Empty = () => null;
const PATHS = ["/", "/s/$sessionId", "/settings", "/settings/$section", "/dev/ui"] as const;

/** The route tree under a root component: RootLayout in the app, AppShell alone in the shell test bed. */
export function buildRouteTree(Root: () => ReactNode) {
  const rootRoute = createRootRoute({ component: Root, notFoundComponent: Empty });
  return rootRoute.addChildren(PATHS.map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: Empty })));
}

export const routeTree = buildRouteTree(RootLayout);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

(If `addChildren` loses the literal path types through `map`, declare the five routes one by one; the type check of M2's `Link` usages is the test.)

`RootLayout.tsx`: unchanged gate; the `ready` branch returns `<AppShell username={state.username} passkeysAvailable={state.passkeysAvailable} onSignedOut={refresh} />`; the two connection lines move into `ConnectionBanner`.

`use-shell-effects.ts` (called by `AppShell`):

```ts
import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { syncAccountAppearance } from "../../features/appearance/index.ts";
import { detectPlatform, installDispatcher, syncKeybindings, useKeybindingsStore } from "../../features/commands/index.ts";
import { itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, useConnectionState } from "../../runtime/index.ts";
import { useSessionsCache } from "./sessions-cache.ts";

export function useShellEffects(mobile: boolean): void {
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const open = useWorkspaceStore((state) => state.open);

  // The URL names the active item; the tab follows it.
  useEffect(() => {
    const item = itemFromPath(pathname, import.meta.env.DEV);
    if (item) open(item);
  }, [pathname, open]);

  // Account settings and the session list, each time the socket opens. The three map their own failures to a
  // status the screens show; the catches only report a rejection a future change might introduce.
  useEffect(() => {
    if (connection !== "open") return;
    void syncAccountAppearance(runtime.rpc).catch(() => reportClientIssue("setting_load_failed"));
    void syncKeybindings(runtime.rpc).catch(() => reportClientIssue("setting_load_failed"));
    void useSessionsCache.getState().refresh(runtime.rpc).catch(() => reportClientIssue("sessions_list_failed"));
  }, [connection, runtime]);

  // One key dispatcher while the shell is mounted.
  useEffect(
    () =>
      installDispatcher({
        win: window,
        platform: detectPlatform(),
        rules: () => useKeybindingsStore.getState().rules,
        shell: () => ({ mobile }),
      }),
    [mobile],
  );
}
```

`AppShell.tsx` (desktop layout; Task 23 adds the phone branch):

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

where `item = itemFromPath(pathname, import.meta.env.DEV)`, `tab = activeTab(ws)`. `Rail`: `<nav aria-label={t("shell.rail.label")} data-slot="rail" className="flex w-rail shrink-0 flex-col items-center gap-s2 border-r border-border bg-bg-side py-s2 rail-right:border-l rail-right:border-r-0">` with the `Mark` (link to `/`, label `app.name`), a flexible spacer, `IconButton icon={IconSettings} label={t("shell.rail.settings")} shortcut={…}` navigating to `/settings/appearance`, and a `Menu` whose trigger is `IconButton icon={IconAccount} label={t("shell.rail.account")}` with items `username` (disabled, informational) and `t("shell.rail.signOut")` → `logout().then(onSignedOut, () => toast({ message: t("shell.signOutFailed"), tone: "error" }))`. `TopBar`: `<header className="flex h-bar shrink-0 items-center gap-s2 border-b border-border bg-bg-side px-s2">` with the tree `IconButton` (label `shell.top.tree`, shortcut tokens of `drawer.tree.toggle`), the title (`truncate text-ui font-semibold`), a spacer, the Inbox `IconButton` (label `shell.top.inbox`) and the palette button (`Button variant="ghost" size="sm"` showing `Kbd` of `palette.toggle`, label `shell.top.palette`) — the drawer and palette buttons call `runCommand("drawer.tree.toggle")`, `runCommand("drawer.inbox.toggle")`, `runCommand("palette.toggle")` (handlers arrive in Tasks 21–22; until then the buttons do nothing visible, which is the expected intermediate state). `ConnectionBanner`: `waiting` → `<Banner tone="offline" title={t("connection.reconnecting")} />`; `outdated` → `<Banner tone="capacity" title={t("connection.outdated")} actions={<Button onClick={() => window.location.reload()}>{t("shell.reload")}</Button>} />`; nothing otherwise. `NotFound`: `EmptyState` with `shell.notFound.title` / `shell.notFound.purpose` and a primary `Button` (`shell.notFound.home`) navigating to `/`.

New `catalog/shell.ts` keys (en / fr): `shell.rail.label` "Agents" / "Agents" (add to `IDENTICAL_IN_FR`), `shell.rail.settings` "Settings" / "Réglages", `shell.rail.account` "Account" / "Compte", `shell.rail.signOut` "Sign out" / "Se déconnecter", `shell.signOutFailed` "Sign-out did not reach pap. Try again." / "La déconnexion n'a pas atteint pap. Réessayez.", `shell.top.tree` "Sessions" / "Sessions" (identical), `shell.top.inbox` "Inbox" / "Boîte de réception", `shell.top.palette` "Search and commands" / "Recherche et commandes", `shell.tab.home` "New session" / "Nouvelle session", `shell.tab.session` "Session" / "Session" (identical), `shell.tab.settings` "Settings" / "Réglages", `shell.reload` "Reload" / "Recharger", `shell.notFound.title` "This page does not exist" / "Cette page n'existe pas", `shell.notFound.purpose` "The link may be old, or the item was closed." / "Le lien est peut-être ancien, ou l'élément a été fermé.", `shell.notFound.home` "Go to the start" / "Aller au début".

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm typecheck && pnpm lint`
Expected: PASS, M2's session tests included (they render their screens directly, not through the shell).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(shell): router, rail, top bar, pane host, not-found screen and connection banners"
```

---

### Task 20: Tab bar and split panes

**Files:**
- Create: `apps/web/src/routes/shell/TabBar.tsx`, `TabBar.test.tsx`
- Create: `apps/web/src/features/workspace/separator.ts`, `separator.test.ts`, `SplitView.tsx`, `SplitView.test.tsx`, `use-element-width.ts`
- Modify: `apps/web/src/routes/shell/PaneHost.tsx`, `AppShell.tsx`, `catalog/shell.ts`

**Interfaces:**
- Consumes: Task 18 (`useWorkspaceStore`, `splitTab`, `pathOfItem`), Task 19 (`itemTitle`, `useSessionsCache`), `OpenTab`, `IconButton`, `Menu` (Tasks 5, 7, 8).
- Produces:
  - `ratioBounds(widthPx: number, minPx: number): readonly [number, number]` (`[max(0.15, min/width), min(0.85, 1 - min/width)]`, `[0.5, 0.5]` below two minimums), `clampRatio(ratio, widthPx, minPx)`, `ratioAfterKey(ratio, key: string, shift: boolean, widthPx, minPx): number | null` (ArrowLeft/ArrowRight move 8 px, 40 px with Shift; Home resets to 0.5; anything else null — Orca `CsvColumnResizeHandle.tsx`), `ratioFromPointer(clientX, left, widthPx, minPx)`.
  - `useElementWidth(ref): number` (ResizeObserver; 0 before the first measure).
  - `SplitView({ ratio: number; onRatio(ratio: number): void; first: ReactNode; second: ReactNode; label: string; minPx?: number })` — below `2 × minPx` it renders `first` only.
  - `TabBar()` (reads the workspace and the sessions cache, navigates on select/close/new).

**Risks / rulings needed:** (a) Below 640 px of pane area the split shows the first pane only (the 320 px minimum cannot hold both): confirm. (b) Tab middle-click and drag-to-reorder are not in M3: confirm.

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
- Modify: `apps/web/src/routes/shell/AppShell.tsx`, `catalog/shell.ts`

**Interfaces:**
- Consumes: Tasks 8, 17, 18, 19.
- Produces:
  - `interface SessionGroup { cwd: string; label: string; sessions: readonly SessionSummary[] }`; `groupSessions(sessions, filter: string, cap?: number): { groups: SessionGroup[]; hidden: number }` (groups by `cwd`, groups and rows by latest `updatedAt` first, filter = NFKD, case-insensitive substring of the cwd, at most `cap` = 200 rows, `hidden` = rows left out).
  - `SessionTree({ onPick(id: string): void })` (shared by the drawer and the phone "Lists" tab).
  - `TreeDrawer({ open; onOpenChange })`, `InboxDrawer({ open; onOpenChange })`.
  - `useShellCommands(state: { setTreeOpen(open: boolean | ((o: boolean) => boolean)): void; setInboxOpen(...); setHelpOpen(...); mobile: boolean; onSignedOut(): void })` registering `drawer.tree.toggle`, `drawer.inbox.toggle`, `settings.open`, `shortcuts.help`, `session.new`, `tab.next`, `tab.prev`, `tab.close`, `pane.split`, `pane.close`, `appearance.cycleMode` (system → night → day → system), `auth.signOut`.

**Risks / rulings needed:** (a) The tree groups by working directory until M4: confirm. (b) The Inbox empty state copy states its purpose without promising a date: confirm. (c) More than 200 sessions: the tree shows 200 and says how many more, pointing to ⌘K (search proper is M4's FTS5): confirm.

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

`shell-commands.test.tsx` (shell bed with tabs `session:a`, `session:b`, active `b`): `runCommand("tab.next")` navigates to `/s/a`; `runCommand("tab.close")` closes the active tab and navigates to the neighbour; `runCommand("pane.split")` adds a split on desktop and returns false (declines) when `mobile`; `runCommand("appearance.cycleMode")` moves `useAppearanceStore` mode `system → night → day → system`; `runCommand("settings.open")` navigates to `/settings/appearance`; `runCommand("auth.signOut")` calls `logout` then `onSignedOut`.

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

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(shell): session tree drawer, inbox drawer and the shell's command handlers"
```

---

### Task 22: Cmd+K command palette

Spec C §7.2 picks cmdk; Orca uses it with its filter off and ranks results itself (`components/WorktreeJumpPalette.tsx`, `cmd-j/palette-results.ts`). Ranking follows T3 (`CommandPalette.logic.ts` 194-322): NFKD, diacritics stripped, every query token a substring of the item's search terms, earlier terms score higher, exact/prefix/substring bonus on the title, ties by recency then order; a leading `>` keeps actions only; Cmd/Ctrl+1..9 runs the n-th visible item. Each group renders at most 50 rows (Orca's section render cap) and the result count is announced politely (Orca's `aria-live` count). The palette module (with cmdk) loads on first open, so it stays out of the initial bundle (spec C §7.4).

**Files:**
- Create: `apps/web/src/features/commands/palette/rank.ts`, `rank.test.ts`, `CommandPalette.tsx`, `CommandPalette.test.tsx`
- Create: `apps/web/src/routes/shell/palette-items.ts`, `palette-items.test.ts`, `PaletteHost.tsx`
- Modify: `apps/web/package.json` (`cmdk`), `apps/web/src/routes/shell/AppShell.tsx`, `catalog/commands.ts`

**Interfaces:**
- Consumes: Tasks 16–21.
- Produces:
  - `type PaletteGroup = "open" | "actions" | "sessions" | "settings"`; `interface PaletteItem { id: string; group: PaletteGroup; title: string; detail?: string; searchTerms: readonly string[]; chord?: readonly string[]; chordJoiner?: "" | "+"; recency?: number; run(): void }`.
  - `normalizeSearch(text: string): string`; `rankItems(items: readonly PaletteItem[], query: string, cap?: number): { groups: Array<{ group: PaletteGroup; items: PaletteItem[] }>; count: number; actionsOnly: boolean }`.
  - `CommandPalette({ open: boolean; onOpenChange(open: boolean): void; items: readonly PaletteItem[]; platform: Platform })` (default export too, for `lazy`).
  - `buildPaletteItems(input: { commands: typeof COMMANDS; has(id: string): boolean; rules: readonly ResolvedRule[]; platform: Platform; names: KeyNames; tabs: readonly Tab[]; sessions: readonly SessionSummary[]; t: Translate; navigate(item: ItemRef): void; run(id: string): void }): PaletteItem[]` (commands without a handler are left out; sessions limited to the 50 most recent).
  - `PaletteHost` registers `palette.toggle` and renders the lazy palette.

**Risks / rulings needed:** (a) FTS5 transcript hits (DESIGN 12's palette) arrive with M4: confirm. (b) On phones the palette opens as a full-width sheet (Task 8's dialog rule): confirm.

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

`CommandPalette.test.tsx` (`// @vitest-environment happy-dom`): opened with the items above, the dialog has `data-command-palette`, the input is focused and labelled `Search commands and sessions`; typing `split` leaves one option; Enter runs it and closes the palette; `Ctrl+2` with an empty query runs the second visible item; typing `zz` shows `No match. Try a folder, a setting or an action.`; typing `> zz` shows `No matching action.`; the polite live region reads `1 result` after `split`; the chord of an item with `chord: ["Ctrl", "\\"]` is shown as a `Kbd`.

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

`CommandPalette.tsx`: `Dialog variant="palette" hideTitle title={t("commands.palette.dialog")} closeLabel={t("ui.close")}`; inside, a wrapper `<div data-command-palette>` holding cmdk's `<Command shouldFilter={false} loop label={…}>` with `<Command.Input aria-label={t("commands.palette.input")} value={query} onValueChange={setQuery} onKeyDown={pickByNumber} />`, `<Command.List>` with one `<Command.Group heading={t(`commands.palette.group.${group}`)}>` per group and `<Command.Item value={item.id} onSelect={() => { onOpenChange(false); item.run(); }}>` rows (title, `detail` in `text-muted font-mono text-code truncate`, `Kbd` of `chord`; selected row `aria-selected:bg-surface-2`); `<Command.Empty>` with `commands.palette.empty` or `commands.palette.emptyActions`; a `<p className="sr-only" aria-live="polite">` with `t("commands.palette.count", { count })`. `pickByNumber`: with Ctrl (or Cmd on Apple) and a digit 1–9, run the n-th visible item (flattened group order) and `preventDefault`. Strings: `commands.palette.dialog` "Command palette" / "Palette de commandes", `commands.palette.input` "Search commands and sessions" / "Rechercher des commandes et des sessions", `commands.palette.group.open|actions|sessions|settings` "Open" "Actions" "Sessions" "Settings" / "Ouverts" "Actions" "Sessions" "Réglages" (identical ones listed), `commands.palette.empty` "No match. Try a folder, a setting or an action." / "Aucun résultat. Essayez un dossier, un réglage ou une action.", `commands.palette.emptyActions` "No matching action." / "Aucune action correspondante.", `commands.palette.count` "{count} results" / "{count} résultats" (use a separate `…countOne` key for 1: "1 result" / "1 résultat"; no concatenation around the number).

`PaletteHost.tsx`: holds `open`, registers `palette.toggle` (toggles), builds items with `buildPaletteItems` from the stores when open, renders `lazy(() => import("../../features/commands/palette/CommandPalette.tsx"))` inside `Suspense` with no fallback (the first open loads it in well under 100 ms locally; DESIGN §7.3 shows nothing for that), and refreshes the sessions cache on open.

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

**Risks / rulings needed:** (a) The Chat / Review / Term switch of DESIGN §8 appears only when the active item offers more than one pane kind; M3 has only chat, so it is absent until M8/M9: confirm. (b) The "Agents" tab shows an empty state without an action until M11 creates agents: confirm. (c) `interactive-widget=resizes-content` (Task 11's viewport meta, T3) helps Chrome on Android; iOS relies on the hook: none.

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

`MobileShell.tsx`: `<div data-shell="mobile" className="flex h-app flex-col">` → top bar (`h-bar`, `Mark` size 20, the active title, an `IconButton icon={IconSearch}` running `palette.toggle`, an `IconButton icon={IconLists}` (label `shell.mobile.tabs`) opening `TabSwitcher`), `ConnectionBanner`, `<div className="min-h-0 flex-1 overflow-y-auto">` (not `<main>`, as on desktop, until P3) with the section's content (agents → `EmptyState` `shell.agents.emptyTitle` "No agent yet" / "Aucun agent pour l'instant", `shell.agents.emptyPurpose` "A long-term agent has its own thread, memory, budget and triggers." / "Un agent de long terme a son propre fil, sa mémoire, son budget et ses déclencheurs."; work → `PaneHost` with the active tab, no split; lists → `SessionTree`; inbox → the Inbox empty state), then `BottomNav`. Navigating to an item (path change) selects `work`.

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
- Create: `apps/web/src/routes/settings/SettingsScreen.tsx`, `SettingsScreen.test.tsx`, `sections.tsx`, `LanguageSection.tsx`, `AccountSection.tsx`, `sections.test.tsx`
- Create: `apps/web/src/routes/shell/shell-context.ts` (username, passkeys, sign-out for sections)
- Modify: `apps/web/src/routes/shell/pane-renderers.tsx` (`settings` → `SettingsScreen`), `AppShell.tsx` (context provider)
- Modify: `apps/web/src/features/auth/LoginScreen.tsx`, `SetupScreen.tsx`, `AddPasskey.tsx` (look and `useT` only; behaviour and their M1 tests unchanged), `LoginScreen.test.tsx` (throttle note)
- Modify: `apps/web/src/i18n/catalog/settings.ts`

**Interfaces:**
- Consumes: Tasks 3 (`switchLocale`, `useT`), 6–8, 18 (`SETTINGS_SECTIONS`, `pathOfItem`), 19.
- Produces:
  - `ShellContext` / `useShell(): { username: string | null; passkeysAvailable: boolean; onSignedOut(): void }`.
  - `SETTINGS_SECTION_RENDERERS: Record<SettingsSection, () => ReactNode>` (`language` and `account` here; `appearance` and `shortcuts` render a one-line `EmptyState` until Tasks 25 and 27 replace them in this map).
  - `SettingsScreen({ section: SettingsSection })`.

**Risks / rulings needed:** (a) The first-run stepper of screen 12 (account → passkey → Pi) is deferred to M7, where the Pi step (providers) exists; setup stays one step: confirm. (b) "Connected devices" (spec C §4.4) is M5's; the Account section shows the username, passkeys and sign-out only: confirm. (c) The throttle note copies screen 12 ("After 5 attempts, waits grow, per address and per account"), which matches M1's throttle (R80): confirm wording.

- [ ] **Step 1: Write the failing tests**

`SettingsScreen.test.tsx` (shell bed at `/settings/language`): a `nav` labelled `Settings sections` lists `Appearance`, `Keyboard shortcuts`, `Language`, `Account & devices` with `aria-current="page"` on Language; clicking `Account & devices` navigates to `/settings/account`; with `matchMedia` reporting a phone, the list is replaced by a `Select` labelled `Section` whose value is the current section; only one settings tab exists while moving between sections.

`sections.test.tsx`:
- Language: choosing `Français` switches the page language at once — the nav entry reads `Langue` and `document.documentElement.lang` is `fr` — with no reload; with `localStorage.setItem` throwing, a status banner says `Applied to this page only: this browser does not keep settings.` (in French after the switch: assert the French text).
- Account: shows the username; `Add a passkey` is present only when passkeys are available; `Sign out` calls `logout` then `onSignedOut`; a failed `logout` shows the error toast and keeps the session screen.
- `LoginScreen.test.tsx` gains: the throttle note is shown under the password form; the passkey button still comes first.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/routes/settings apps/web/src/features/auth`
Expected: FAIL.

- [ ] **Step 3: Implement**

`SettingsScreen.tsx`: `<div className="flex min-h-0 flex-1">` with, on desktop, `<nav aria-label={t("settings.nav.label")} className="w-56 shrink-0 border-r border-border bg-bg-side p-s2">` holding a `label-hud text-muted` group heading (`settings.nav.personal`) and one `Link` per section (`flex h-control items-center rounded-sm px-s2 text-ui`, current: `bg-surface-2 text-fg` + a 2 px agent rule; DESIGN's selected-item rule), and `<section className="min-w-0 flex-1 overflow-y-auto p-s4" aria-labelledby=…>` with an `h1` (`text-h1`) and `SETTINGS_SECTION_RENDERERS[section]()`. On phones (`useIsPhone()`), a `Select` labelled `settings.nav.section` replaces the nav (`onChange` navigates). Changing section navigates to `pathOfItem({ kind: "settings", section })`, which updates the one settings tab (Task 18).

`LanguageSection.tsx`: `Segmented` labelled `settings.language.label` with options `en` → `t("settings.language.en")` ("English"), `fr` → `t("settings.language.fr")` ("Français") and value `useLocale()`; `onChange` → `const stored = switchLocale(locale)`; when `stored` is false, `Banner tone="capacity"` with `settings.language.notStored`.

`AccountSection.tsx`: the username in `font-mono`, `AddPasskey` (existing component, its "Passkey added." status now rendered here in a `role="status"` line) when `passkeysAvailable`, and `Button variant="secondary"` `settings.account.signOut` with the same `logout().then(onSignedOut, toast)` as the rail.

`LoginScreen` / `SetupScreen` / `AddPasskey`: switch `t` to `useT()`; layout `<main className="flex min-h-full items-center justify-center p-s4">` around `<div className="flex w-full max-w-sm flex-col gap-s4 rounded-md border border-border-strong bg-surface p-s5">` headed by `Mark size={32}` + `Wordmark name={t("app.name")} tagline={t("app.tagline")}`; title `text-h1`; Login adds `<p className="text-ui text-muted">{t("login.throttleNote")}</p>` under the form. No behaviour, label or button text changes (M1 tests and the e2e journey select by them).

New keys (en / fr): `app.tagline` "pi agentic platform" (identical: add to `IDENTICAL_IN_FR`), `login.throttleNote` "After 5 attempts, waits grow, per address and per account." / "Après 5 essais, l'attente augmente, par adresse et par compte.", `settings.nav.label` "Settings sections" / "Sections des réglages", `settings.nav.personal` "Personal" / "Personnel", `settings.nav.section` "Section" / "Section" (identical), `settings.section.appearance` "Appearance" / "Apparence", `settings.section.shortcuts` "Keyboard shortcuts" / "Raccourcis clavier", `settings.section.language` "Language" / "Langue", `settings.section.account` "Account & devices" / "Compte et appareils", `settings.language.label` "Language" / "Langue", `settings.language.notStored` "Applied to this page only: this browser does not keep settings." / "Appliqué à cette page seulement : ce navigateur ne garde pas les réglages.", `settings.account.username` "Signed in as" / "Connecté en tant que", `settings.account.signOut` "Sign out" / "Se déconnecter".

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm test:unit scripts/literal-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web
git commit -m "feat(settings): settings screen with language and account sections; restyled sign-in"
```

---

### Task 25: Settings › Appearance — account and device controls, live, with reset and Undo

DESIGN.md §13 and screen 08: every change applies at once (the app is the live preview, plus a small sample); "Reset to defaults" covers both scopes and offers Undo for 5 s (DESIGN §9.1 toast); the account scope says whether it is saved; the device scope says when the browser refuses to keep it.

**Files:**
- Create: `apps/web/src/features/appearance/AppearancePanel.tsx`, `ThemeSection.tsx`, `ReadingSection.tsx`, `DetailsSection.tsx`, `AppearancePreview.tsx`, `AppearancePanel.test.tsx`
- Modify: `apps/web/src/routes/settings/sections.tsx` (`appearance` → `AppearancePanel`), `apps/web/src/features/appearance/index.ts`, `catalog/settings.ts`

**Interfaces:**
- Consumes: Task 15 store (`account`, `device`, `accountStatus`, `deviceStored`, setters, `resetAll`), Task 13 (`SIZE_RANGES`, `DEFAULT_DEVICE`), primitives, AI components (preview).
- Produces: `AppearancePanel()`.

**Risks / rulings needed:** (a) Font choices are the bundled fonts or the system stack (no CDN, no arbitrary installed fonts; T3 lists installed fonts, which needs a permission prompt): confirm. (b) Size sliders: UI 12–16 px, chat 13–18 px, code 11–16 px, each with "follow density": confirm ranges. (c) Chat width options Full (default), Wide (64rem), Narrow (48rem): confirm.

- [ ] **Step 1: Write the failing tests**

`AppearancePanel.test.tsx` (`// @vitest-environment happy-dom`; `TooltipProvider` + `Toaster`; reset the store before each test):
- "mode Night/Day/System writes the account scope": click `Day` in the `Mode` segmented → `account.mode === "day"`.
- "the dark theme lists Night Control, High contrast and dark custom themes; the light one Day · Papier and light custom themes": with a custom night theme `Ocean` in the account, the `Dark theme` select's trigger shows `Night Control` and its options (open via keyboard) include `High contrast` and `Ocean`, not `Day · Papier`.
- "density and sizes write the device scope; Follow density clears a size": click `Comfortable` → `device.density === "comfortable"`; move the `UI size` slider to 15 (Radix slider: press ArrowRight on the thumb twice from the density default 13) → `device.uiSize === 15`; click `Follow density` → `null`.
- "switches write the account scope": `Uppercase labels` off → `uppercaseLabels: false`; `Background grid` off → `grid: false`; `Rail position` Right, `Agent avatars` Glyph, `Tool card detail` Full.
- "motion and chat width write the device scope": `None` → `motion: "none"`; `Narrow` → `chatWidth: "narrow"`.
- "reset covers both scopes and Undo restores them": after the changes above, click `Reset to defaults` → both scopes are the defaults and a toast `Appearance reset` with `Undo` is shown; click `Undo` → the changed values are back.
- "says where the account copy stands": `accountStatus` `saving` → `Saving…`; `saved` → `Saved to your account`; `error` → `Not saved: pap did not answer. Your next change tries again.`; `load-error` → `Showing this device's copy: your saved appearance could not be loaded.`; `deviceStored: false` → `This browser does not keep device settings: they apply to this page only.`
- "the preview shows a you message, an agent message, a tool card and a primary button": the `Preview` region contains `[data-slot="message"][data-author="you"]`, `[data-author="agent"]`, `[data-slot="tool-card"]`, `[data-variant="primary"]`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/appearance/AppearancePanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`AppearancePanel.tsx`: a header row (`h2` `settings.appearance.title`, the status line, `Button variant="secondary"` `settings.appearance.reset` → `const previous = resetAll(); toast({ message: t("settings.appearance.resetDone"), action: { label: t("settings.appearance.undo"), altText: t("settings.appearance.undoAlt"), run: () => { setAccount(previous.account); setDevice(previous.device); } } })`), the `deviceStored` banner, then `ThemeSection`, `ReadingSection`, `DetailsSection`, and `AppearancePreview` beside them on wide screens (stacked under 1024 px). Each section is a `<section aria-labelledby>` with a `label-hud` heading and a scope hint (`settings.appearance.scopeAccount` "Your account, on every device" / "Votre compte, sur tous vos appareils"; `settings.appearance.scopeDevice` "This device" / "Cet appareil").

`ThemeSection.tsx` (account): `Segmented` Mode (`night`/`day`/`system` → `settings.appearance.mode.*`), `Select` Dark theme (`night` → "Night Control" (identical), `hc` → `settings.appearance.preset.hc` "High contrast" / "Contraste élevé", plus custom themes with `base: "night"` by name), `Select` Light theme (`day` → `settings.appearance.preset.day` "Day · Papier" / "Jour · Papier", plus `base: "day"` custom themes). Task 26 adds the custom theme list and editor below.

`ReadingSection.tsx` (device): `Segmented` Density; three `Slider`s (`SIZE_RANGES`, `valueText` `t("settings.appearance.px", { value })`), each followed by a `Button variant="ghost" size="sm"` `settings.appearance.followDensity` shown when the size is not null; `Segmented` Chat width (`full`/`wide`/`narrow`); `Segmented` Motion (`system`/`reduced`/`none`).

`DetailsSection.tsx` (account): `Select` UI font (`manrope` "Manrope", `system` `settings.appearance.fontSystem` "System font" / "Police du système"), `Select` Mono font (`jetbrains-mono` "JetBrains Mono", `system`), `Switch` Uppercase labels, `Switch` Background grid, `Segmented` Rail position, `Segmented` Agent avatars (`outlined`/`tinted`/`glyph`), `Segmented` Tool card detail (`compact`/`expanded`/`full`).

`AppearancePreview.tsx`: `<section aria-label={t("settings.appearance.preview")}>` with `Message author="you"`, `Message author="agent"` (sample texts from `settings.appearance.sample.*` keys), `ToolCard detail={account.toolDetail}` (`bash`, a sample summary and duration), an `Avatar avatarStyle={account.avatarStyle}`, a `Chip tone="att"` and a primary `Button`.

All strings: `settings.appearance.*` keys in en and fr (sentence case; preset and font proper names listed in `IDENTICAL_IN_FR`).

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit apps/web && pnpm test:unit scripts/literal-coverage.test.ts scripts/class-coverage.test.ts`
Expected: PASS.

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
- Create: `apps/web/src/features/appearance/theme-io.ts`, `theme-io.test.ts`, `ThemeEditor.tsx`, `ThemeEditor.test.tsx`, `CustomThemes.tsx`
- Modify: `apps/web/src/features/appearance/ThemeSection.tsx` (list + editor entry points), `catalog/settings.ts`

**Interfaces:**
- Consumes: `CustomTheme` (Task 12), `deriveTheme`, `tokenVars`, `roleChecks` (Task 13), store (Task 15), `PRESET_TOKENS` (Task 1), `Dialog`, `TextField`, `Segmented`, `Chip`, `toast`.
- Produces:
  - `MAX_THEME_FILE_BYTES = 16384`; `type ThemeFileError = { kind: "too_large" } | { kind: "not_json" } | { kind: "invalid"; path: string }`; `parseThemeFile(text: string): { ok: true; theme: Omit<CustomTheme, "id"> } | { ok: false; errors: ThemeFileError[] }` (at most 20 errors); `exportThemeFile(theme: CustomTheme): string` (DESIGN §13.1 shape, no `id`, 2-space JSON); `newThemeId(name: string, taken: ReadonlySet<string>): string` (T3 id rule, unique, `theme` fallback for a name with no ASCII letters).
  - `ThemeEditor({ open; onOpenChange; initial: Omit<CustomTheme, "id">; onSave(theme: Omit<CustomTheme, "id">): void })`; `CustomThemes()` (list: Edit, Duplicate, Export, Delete; Import; "Duplicate & edit" from a preset; disabled at 16 themes with a hint).

**Risks / rulings needed:** (a) Deleting a custom theme in use switches that side back to its preset (Night Control or Day · Papier), with Undo: confirm. (b) The native colour input (`<input type="color">`, Safari 16.4 supports it) sits next to a hex field: confirm.

- [ ] **Step 1: Write the failing tests**

`theme-io.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { exportThemeFile, MAX_THEME_FILE_BYTES, newThemeId, parseThemeFile } from "./theme-io.ts";

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
  it("makes unique ids that follow the id rule", () => {
    expect(newThemeId("My Theme!", new Set())).toBe("my-theme");
    expect(newThemeId("My Theme!", new Set(["my-theme"]))).toBe("my-theme-2");
    expect(newThemeId("夜", new Set())).toBe("theme");
  });
});
```

`ThemeEditor.test.tsx`: editing the `Text` role's hex field to `#1A2333` (unreadable on the example's background) turns its chip to `Below AA` with the ratio in tabular figures; `Save` then opens a confirmation dialog listing `Text` and its ratio, `Keep editing` closes it without calling `onSave`, `Save anyway` calls `onSave` with the edited roles; an invalid hex (`#12`) disables Save and marks the field invalid; the preview region carries `data-theme="night"` and an inline `--bg` equal to the role (and nothing but hex values in its style); `Import` with a file whose text is the hostile JSON above lists `roles.bg` and `roles.agent` errors and leaves the fields as they were.

`CustomThemes` (in the same test file): `Duplicate & edit` from `Night Control` opens the editor with the night preset roles (`PRESET_TOKENS.night` values for bg, surface, text, agent, you, attn, ok, err) and the name `Night Control copy`; saving adds a theme with a fresh id; deleting the theme in use as the dark theme sets `darkTheme` back to `night` and shows a toast with Undo; with 16 custom themes, `Duplicate & edit` is disabled and says why.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/features/appearance`
Expected: FAIL.

- [ ] **Step 3: Implement**

`theme-io.ts`:

```ts
import { CustomTheme } from "@pap/contracts";

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

/** T3's id rule (^[a-z0-9][a-z0-9-]{0,47}$), unique among `taken`. */
export function newThemeId(name: string, taken: ReadonlySet<string>): string {
  const slug = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "theme";
  if (!taken.has(slug)) return slug;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
  return `${slug}-${Date.now().toString(36)}`.slice(0, 48);
}
```

`ThemeEditor.tsx`: `Dialog` (`settings.theme.editorTitle`) with a name `TextField`, a base `Segmented` (`night`/`day`), one row per role in `THEME_ROLES` order (label `settings.theme.role.<role>`, `<input type="color" aria-label=…>` bound to the role, a hex `TextField` validated against `/^#[0-9a-fA-F]{6}$/`, the role's `RoleCheck` as `Chip tone={passes ? "ok" : "att"} label={passes ? t("settings.theme.aa") : t("settings.theme.belowAa")}` followed by the ratio `formatRatio` (one decimal, `tabular-nums`), and "adjusted to #xxxxxx" when `adjusted`), the fills' checks under them, and a preview `<div data-theme={base} style={tokenVars(deriveTheme(draft))}>` containing a you message, an agent message and a primary button. Save: invalid hex → disabled; any failing check → a second `Dialog` (`settings.theme.confirmTitle` "Save below AA contrast?" / "Enregistrer sous le contraste AA ?", listing the failing roles and ratios) with `Keep editing` and `Save anyway`. Import: a hidden `<input type="file" accept="application/json,.json">` read with `file.text()` after checking `file.size <= MAX_THEME_FILE_BYTES`; errors shown as a list (`settings.theme.importError.*`). Export: `URL.createObjectURL(new Blob([exportThemeFile(theme)], { type: "application/json" }))` on a temporary `<a download="<id>.json">`, revoked right after the click.

`CustomThemes.tsx`: list of `account.customThemes` (name, base chip, Edit / Duplicate / Export / Delete as `IconButton`s with labels), `Import` and `Duplicate & edit` (a `Menu` of the three presets, built from `PRESET_TOKENS` roles), all disabled at 16 themes with `settings.theme.limit` ("16 custom themes at most. Delete one to add another." / "16 thèmes personnalisés au plus. Supprimez-en un pour en ajouter un autre."). Saving a new theme: `setAccount({ ...account, customThemes: [...account.customThemes, { id: newThemeId(name, ids), ...theme }] })`. Deleting the theme in use resets that side to its preset and offers Undo.

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
- Modify: `apps/web/src/routes/settings/sections.tsx` (`shortcuts` → `ShortcutsEditor`), `apps/web/src/features/commands/index.ts`, `catalog/commands.ts`

**Interfaces:**
- Consumes: Tasks 12, 16, 17 (`useKeybindingsStore`, `COMMANDS`, `DEFAULT_KEYBINDINGS`, `chordFromEvent`, `parseChord`, `isReserved`, `conflictsOf`, `chordTokens`, `keyNames`), primitives.
- Produces:
  - `MAX_KEYBINDINGS_FILE_BYTES = 65536`; `parseKeybindingsFile(text: string): { ok: true; rules: KeybindingRule[]; issues: Array<{ index: number; problem: "shape" | "key" | "when" | "command" | "reserved" }> } | { ok: false; error: "too_large" | "not_json" | "not_array" | "too_many" }` (entries that fail the rule shape are reported and dropped; `reserved` is a warning, the rule is kept); `exportKeybindingsFile(rules: readonly KeybindingRule[]): string`.
  - `recordedChordProblem(chord: string, command: string, platform): "no_modifier" | "reserved" | null` (bare keys allowed only for `shortcuts.help` and function keys).
  - `ShortcutsEditor()`.

**Risks / rulings needed:** (a) A conflict is a warning (T3), not a refusal (Orca); a reserved chord is refused by the recorder and only warned in JSON: confirm. (b) No visual `when` builder (T3 has one): `when` is edited in the JSON view only: confirm.

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

(Rules whose `key` or `when` do not parse are kept in `rules` — they are the user's text — and reported; `mergeWithDefaults` drops them at use, exactly as Task 16 does.)

`ShortcutsEditor.test.tsx` (`// @vitest-environment happy-dom`, platform `other`):
- the `Open the command palette` row shows `Ctrl` `K` and a `Default` badge; searching `palette` leaves that row only.
- `Change` on that row turns into a pressed recorder reading `Press keys…`; pressing `Ctrl+Shift+P` saves the user rule `{ key: "mod+shift+p", command: "palette.toggle" }` (store `user`), the row shows `Custom` and `Ctrl` `Shift` `P`; the dispatcher (installed in the test) did not run the palette handler for that keypress.
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

`ShortcutsEditor.tsx`: search `TextField`; groups by `COMMANDS[].group` (`commands.group.*` headings); rows (`ShortcutRow`): title, the effective chord tokens (`Kbd`), the badge (`Default` / `Custom`, `Chip tone="mut"` / `"run"`), warnings from `conflictsOf` (`commands.editor.conflict`, "Conflicts with {commands}" — the command titles joined by the locale's list format via `Intl.ListFormat`, no hand-made concatenation) and `isReserved`, then `Change`, `Reset` (shown for custom rows), `Remove`. Writes go through `useKeybindingsStore.getState().setUser(next)` (new `user` array: the recorded rule replaces the user rules of that command). `KeybindingsJson.tsx`: a `Collapsible` "Edit as JSON" with a mono `TextField multiline` holding `exportKeybindingsFile(user)`, `Apply` (parse → `setUser(rules)` + issue list `commands.editor.issue.<problem>` with `{ index: index + 1 }`), `Import` (file ≤ 64 KiB, same path), `Export` (blob download as in Task 26).

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
# Phase 8 — Gallery, browser journeys, budgets

### Task 28: `/dev/ui` gallery — every component, three themes, three densities

DESIGN.md §9.2: "Every component is shown in /dev/ui in all three themes and three densities. The page returns 404 in production and sits behind auth." The gallery is a dev-only pane behind the auth gate (`/dev/ui` exists only when `import.meta.env.DEV`); production builds do not contain it, and `/dev/ui` there shows the not-found screen (the SPA fallback answers 200, so ADR 0007 records the deviation from "404"). Screenshots (Task 31) use a standalone, test-only gallery build served by `vite preview`, never by the daemon. Themes and densities are applied to the gallery's own frames: every token selector is an attribute selector (Task 1), so `[data-theme]`/`[data-density]` on a wrapper re-themes its subtree.

**Files:**
- Create: `apps/web/src/gallery/Gallery.tsx`, `GalleryFrame.tsx`, `sections/BrandSection.tsx`, `sections/PrimitivesSection.tsx`, `sections/AiSection.tsx`, `fixtures.ts`, `main.tsx`, `Gallery.test.tsx`
- Create: `apps/web/gallery.html`, `apps/web/vite.gallery.config.ts`, `docs/adr/0007-dev-ui-not-shipped.md`
- Modify: `apps/web/package.json` (`build:gallery` script), `apps/web/src/routes/shell/pane-renderers.tsx` (`dev-ui`), `eslint.config.js` (element `web-gallery`, ignore `**/dist-gallery/**`), `knip.json`, `.gitignore` (append `apps/web/dist-gallery/`), `.prettierignore` (append `apps/web/dist-gallery/`), `catalog/gallery.ts`

**Interfaces:**
- Consumes: every export of `@pap/ui`; `useT`.
- Produces:
  - `Gallery({ standalone?: boolean })` — controls (theme `Segmented` night/day/hc, density `Segmented` compact/comfortable/mixed, an "all nine" switch), initial values from `?theme=&density=` (unknown values fall back to night/compact); each section is `<section data-gallery-section="brand|primitives|ai">`, each component instance is wrapped in `<figure data-gallery-item="<ExportName>">` with a caption.
  - `GalleryFrame({ theme: ThemeName; density: Density; children })` → `<div data-theme data-density className="bg-grid text-fg …">`.
  - `pnpm --filter @pap/web build:gallery` → `apps/web/dist-gallery/gallery.html`.
  - Boundary element `web-gallery` (`apps/web/src/gallery`): may import `ui`, `web-i18n`, `web-gallery`; `web-routes` may import it.

**Risks / rulings needed:** (a) ADR 0007's reading of "returns 404 in production" (route not shipped, SPA not-found screen, no daemon change): owner question Q5. (b) Overlays (dialogs, sheets, menus, toasts, tooltips) are opened from buttons in the gallery and are not part of the screenshots (a modal would cover the page); journeys cover them: confirm.

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

describe("/dev/ui gallery", () => {
  it("shows every component @pap/ui exports", async () => {
    const page = await mount(<Gallery standalone />);
    const shown = new Set([...page.container.querySelectorAll("[data-gallery-item]")].map((el) => el.getAttribute("data-gallery-item")));
    expect(components.filter((name) => !shown.has(name))).toEqual([]);
    await page.unmount();
  });

  it("starts from the theme and density of the address, and falls back on unknown ones", async () => {
    window.history.replaceState(null, "", "/gallery.html?theme=hc&density=comfortable");
    const page = await mount(<Gallery standalone />);
    const frame = page.container.querySelector("[data-theme]");
    expect([frame?.getAttribute("data-theme"), frame?.getAttribute("data-density")]).toEqual(["hc", "comfortable"]);
    await page.unmount();
    window.history.replaceState(null, "", "/gallery.html?theme=sepia&density=huge");
    const fallback = await mount(<Gallery standalone />);
    expect(fallback.container.querySelector("[data-theme]")?.getAttribute("data-theme")).toBe("night");
    await fallback.unmount();
  });

  it("renders nine frames when asked for all", async () => {
    window.history.replaceState(null, "", "/gallery.html?all=1");
    const page = await mount(<Gallery standalone />);
    expect(page.container.querySelectorAll('[data-slot="gallery-frame"]')).toHaveLength(9);
    await page.unmount();
  });
});
```

(Components that need a provider render inside the gallery's own `TooltipProvider`; `Dialog`, `Menu`, `toast` show as buttons that open them, wrapped in their `data-gallery-item` figure.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/gallery`
Expected: FAIL.

- [ ] **Step 3: Implement**

Sections show, with sample content from `fixtures.ts` (data, exempt from the literal gate): Brand (`Mark` 16/24/48 and `mode="day"`, `Wordmark` with tagline); Primitives (`Button` × 4 variants × 2 sizes + disabled, a `Spinner`, `IconButton` ghost/secondary with a badge, `Tooltip` trigger, `Kbd`, `TextField` with hint and error, `Select`, `Switch`, `Checkbox`, `Slider`, `Segmented`, `Chip` × 6 tones, `Badge` 3 / 120, `Avatar` × 3 styles × presence, `Meter` tokens/cost, `ProgressBar` determinate/indeterminate, `Banner` × 4, `EmptyState`, `OpenTab` active/idle/running, `Collapsible`, buttons opening `Dialog` (center, sheet, drawer-left, drawer-right, palette), `Menu`, and a `toast` with Undo); AI (`Message` you/agent/tool with meta and actions, `MessageBranch`, `AuthorGroup`, `DaySeparator`, `RunStatusChip` × 5, `Fence`, `Reasoning` streaming and settled, `ToolCard` × 3 details + running + error, `ApprovalCard` two-answer and four-answer with taint and context). Every visible chrome string goes through `useT` (`gallery.*` keys); sample content does not.

`main.tsx` (standalone entry, test artifact):

```tsx
import "../csp-safe-zod.ts";
import { Toaster, TooltipProvider } from "@pap/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../i18n/index.ts";
import "../styles.css";
import { Gallery } from "./Gallery.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from gallery.html");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <Gallery standalone />
      <Toaster closeLabel={t("ui.dismiss")} />
    </TooltipProvider>
  </StrictMode>,
);
```

`apps/web/gallery.html`: the `index.html` head (charset, viewport, color-scheme, `<title>pap · UI gallery</title>`) and `<script type="module" src="/src/gallery/main.tsx"></script>`.

`apps/web/vite.gallery.config.ts`:

```ts
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.ts";

// A test artifact for the screenshots of Task 31: the gallery alone, built next to (never into) the shipped dist.
export default mergeConfig(
  base,
  defineConfig({
    build: { outDir: "dist-gallery", emptyOutDir: true, rollupOptions: { input: "gallery.html" } },
    preview: { host: "127.0.0.1", port: 7795, strictPort: true },
  }),
);
```

`apps/web/package.json` scripts: `"build:gallery": "vite build --config vite.gallery.config.ts"`.

`pane-renderers.tsx`: `"dev-ui": () => (DevGallery ? <Suspense fallback={null}><DevGallery /></Suspense> : <NotFound />)` with `const DevGallery = import.meta.env.DEV ? lazy(() => import("../../gallery/Gallery.tsx").then((m) => ({ default: () => <m.Gallery /> }))) : null;` (Task 32 proves the production build ships none of it).

`docs/adr/0007-dev-ui-not-shipped.md`:

```markdown
# 0007 — /dev/ui is not shipped; unknown routes show the not-found screen

Date: 2026-10-11 · Status: accepted · Deviation from: DESIGN.md §9.2 ("The page returns 404 in production and sits behind auth")

## Context
The daemon answers every navigation outside the reserved prefixes with index.html (R78): the SPA, not the server, decides what a
path shows. A literal HTTP 404 for /dev/ui would need a daemon route for a page that only exists in development.

## Decision
The gallery code is compiled only when `import.meta.env.DEV` is true. In a production build, /dev/ui is an unknown path: the app shows
its not-found screen (HTTP 200 from the SPA fallback). In development the gallery is a pane behind the auth gate. Visual regression
(Task 31) screenshots a separate, test-only build of the gallery (`build:gallery`, `apps/web/dist-gallery`) served by `vite preview`.

## Consequences
Nothing of the gallery reaches users; the build-output test checks it. If the owner wants a real 404, the daemon gains one reserved
path; nothing in the web app changes.
```

`eslint.config.js`: element `{ type: "web-gallery", pattern: "apps/web/src/gallery" }`, rule `{ from: "web-gallery", allow: ["web-gallery", "ui", "web-i18n"] }`, `"web-gallery"` added to `web-routes`' allow list, and `"**/dist-gallery/**"` added to `ignores`. `knip.json` `apps/web` entries gain `"gallery.html"`, `"vite.gallery.config.ts"`, `"src/gallery/main.tsx"`.

- [ ] **Step 4: Run the tests and the build**

Run: `pnpm test:unit apps/web && pnpm --filter @pap/web build:gallery && ls apps/web/dist-gallery/gallery.html && pnpm lint && pnpm knip`
Expected: PASS; the gallery file exists.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add apps/web eslint.config.js knip.json .gitignore .prettierignore docs/adr/0007-dev-ui-not-shipped.md
git commit -m "feat(ui): /dev/ui gallery of every component in three themes and three densities"
```

---

### Task 29: Playwright in the official container — runner, config, daemons, guards

The host is a headless VPS without Chrome, libatk or sudo. Browsers run **inside** the official image `mcr.microsoft.com/playwright:v<version>-noble` (R51), pinned to the exact `@playwright/test` version, started with rootless podman locally (docker in CI, same image). The image runs `playwright run-server`; the test runner, the global setup and the daemons run on the host with its Node 24 (the image's Node may be older than the daemon's floor). The browser reaches the daemons through Playwright's documented `connectOptions.exposeNetwork: "<loopback>"`, which tunnels the browser's `localhost` requests back to the client side, so no `--network host` is needed; `PAP_E2E_NETWORK=host` switches to `--network host` if a podman setup blocks the tunnel (R51's fallback). This brings back the Playwright pieces M1 removed (R128), deliberately.

**Files:**
- Create: `scripts/e2e.ts`, `scripts/e2e-config.test.ts`, `playwright.config.ts`
- Create: `e2e/state.ts`, `e2e/global-setup.ts`, `e2e/global-teardown.ts`, `e2e/guards.ts`, `e2e/auth.ts`, `e2e/fixtures/approval-script.json`, `e2e/smoke.spec.ts`
- Modify: root `package.json` (`@playwright/test`, script `e2e`), `pnpm-lock.yaml`, `tsconfig.json` (include `e2e/**/*.ts`), `knip.json` (e2e entries, `ignoreBinaries` podman/docker), `.gitignore` (append `e2e/.state/`)

**Interfaces:**
- Consumes: the built daemon (`apps/daemon/dist/main.js`) and worker, `apps/web/dist`, `apps/web/dist-gallery` (Task 28), `packages/pi-host/src/testing/network-guard.ts` (as `pnpm smoke` uses it), the daemon's `setup_url` / `listening` log lines.
- Produces:
  - `pnpm e2e [playwright args]`: pulls the image (`PAP_E2E_SKIP_PULL=1` skips), starts the browser server, runs `playwright test`, always stops the container. Env: `PAP_E2E_RUNTIME` (`podman` default, `docker` in CI), `PAP_E2E_NETWORK` (`tunnel` default, `host`).
  - `E2E_PORTS = { chromium: 7791, webkit: 7792, "chromium-phone": 7793, "webkit-phone": 7794 }`, `GALLERY_PORT = 7795`, `DaemonState { setupUrl; cwd; pid; root }`, `readState(project)`.
  - `installGuards(page)`, `expectCleanScreen(page, options?: { coarse?: boolean })` (zero CSP violations, zero console errors, no element with a native `title`, and on coarse pointers every visible interactive element at least 44 × 44 px).
  - `ensureSignedIn(page, state)` (creates the owner from the setup link on first use, signs in otherwise).

**Risks / rulings needed:** (a) `npx -y playwright@<version> run-server` inside the container fetches the package from the npm registry at each container start (the image ships browsers, not the npm package); CI has network, locally it is one download per run: confirm, or rule a derived image with the package baked in. (b) The image tag `v<version>-noble` must exist for the version pnpm resolves under `minimumReleaseAge` (Microsoft publishes one per release; the runner fails with the pull error otherwise). (c) If `exposeNetwork` does not reach the host daemons under rootless podman, the fallback is `--network host` (R51): the implementer records which one this host needed.

- [ ] **Step 1: Add Playwright and pin the image to it**

Run: `pnpm add -Dw -E @playwright/test`
Record the version pnpm chose (it is the image tag). No `playwright install`: the host never downloads browsers.

- [ ] **Step 2: Write the failing config test**

`scripts/e2e-config.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { containerArgs, imageFor } from "./e2e.ts";

const root = (path: string) => new URL(`../${path}`, import.meta.url);
const pkg = JSON.parse(readFileSync(root("package.json"), "utf8")) as { devDependencies: Record<string, string>; scripts: Record<string, string> };

describe("e2e wiring (R51)", () => {
  it("pins @playwright/test exactly and derives the image tag from it", () => {
    const version = pkg.devDependencies["@playwright/test"] ?? "";
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(imageFor(version)).toBe(`mcr.microsoft.com/playwright:v${version}-noble`);
  });

  it("publishes the browser server on loopback only, or shares the host network when asked", () => {
    expect(containerArgs({ name: "n", image: "i", version: "1.2.3", port: 4567, network: "tunnel" })).toEqual(["run", "-d", "--rm", "--init", "--name", "n", "-p", "127.0.0.1:4567:3000", "i", "/bin/sh", "-c", "cd /home/pwuser && npx -y playwright@1.2.3 run-server --port 3000 --host 0.0.0.0"]);
    expect(containerArgs({ name: "n", image: "i", version: "1.2.3", port: 4567, network: "host" })).toEqual(["run", "-d", "--rm", "--init", "--name", "n", "--network", "host", "i", "/bin/sh", "-c", "cd /home/pwuser && npx -y playwright@1.2.3 run-server --port 4567 --host 127.0.0.1"]);
  });

  it("never uses the dev port 30141 and runs in CI with docker", () => {
    const config = readFileSync(root("playwright.config.ts"), "utf8") + readFileSync(root("e2e/state.ts"), "utf8");
    expect(config).not.toContain("30141");
    expect(pkg.scripts.e2e).toBe("node --disable-warning=ExperimentalWarning scripts/e2e.ts");
    const ci = parse(readFileSync(root(".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { env?: Record<string, string>; steps: Array<{ run?: string }>; "timeout-minutes"?: number }> };
    expect(ci.jobs.e2e?.env?.PAP_E2E_RUNTIME).toBe("docker");
    expect(ci.jobs.e2e?.steps.some((step) => step.run === "pnpm e2e")).toBe(true);
    expect(ci.jobs.e2e?.["timeout-minutes"]).toBeLessThanOrEqual(25);
  });
});
```

(The last case passes only after Task 30 adds the CI job: mark it `it.todo` in this task's commit, and turn it into `it` in Task 30.)

Run: `pnpm test:unit scripts/e2e-config.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the runner**

`scripts/e2e.ts`:

```ts
// Runs the Playwright suite with the browsers inside the official image (R51): this host has no Chrome, libatk or sudo.
// The image runs `playwright run-server`; the tests, the global setup and the daemons stay on the host (Node 24).
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const READY_MS = 120_000; // the first start downloads the npm package inside the container
const STOP_MS = 20_000;
const REQUIRED = ["apps/daemon/dist/main.js", "packages/pi-host/dist/main.js", "apps/web/dist/index.html", "apps/web/dist-gallery/gallery.html"];

export const imageFor = (version: string): string => `mcr.microsoft.com/playwright:v${version}-noble`;

export function containerArgs(o: { name: string; image: string; version: string; port: number; network: "tunnel" | "host" }): string[] {
  const listen = o.network === "host" ? `--port ${o.port} --host 127.0.0.1` : "--port 3000 --host 0.0.0.0";
  const net = o.network === "host" ? ["--network", "host"] : ["-p", `127.0.0.1:${o.port}:3000`];
  return ["run", "-d", "--rm", "--init", "--name", o.name, ...net, o.image, "/bin/sh", "-c", `cd /home/pwuser && npx -y playwright@${o.version} run-server ${listen}`];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address && address.port !== 30141 ? resolve(address.port) : reject(new Error("no usable port"))));
    });
  });
}

async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline) {
    try {
      // run-server answers any HTTP request (with an error status): an answer means it is listening.
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`the browser server did not answer within ${READY_MS / 1000} s`);
}

async function main(): Promise<number> {
  const missing = REQUIRED.filter((file) => !existsSync(join(REPO, file)));
  if (missing.length > 0) {
    console.error(`e2e: build first (pnpm build && pnpm --filter @pap/web build:gallery); missing: ${missing.join(", ")}`);
    return 1;
  }
  const runtime = process.env.PAP_E2E_RUNTIME === "docker" ? "docker" : "podman";
  const network = process.env.PAP_E2E_NETWORK === "host" ? "host" : "tunnel";
  const version = (JSON.parse(readFileSync(join(REPO, "node_modules/@playwright/test/package.json"), "utf8")) as { version: string }).version;
  const image = imageFor(version);
  if (process.env.PAP_E2E_SKIP_PULL !== "1") await run(runtime, ["pull", "--quiet", image], { timeout: 600_000 });
  const port = await freePort();
  const name = `pap-e2e-${process.pid}-${Date.now().toString(36)}`;
  await run(runtime, containerArgs({ name, image, version, port, network }), { timeout: 60_000 });
  const stop = async () => {
    await run(runtime, ["stop", "-t", "5", name], { timeout: STOP_MS }).catch((error: unknown) => console.error(`e2e: could not stop ${name}: ${String(error)}`));
  };
  const onSignal = () => void stop().finally(() => process.exit(130));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await waitReady(port);
    const child = spawn("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
      cwd: REPO,
      stdio: "inherit",
      env: { ...process.env, PAP_E2E_WS_ENDPOINT: `ws://127.0.0.1:${port}/`, PAP_E2E_NETWORK: network },
    });
    return await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  } catch (error) {
    const logs = await run(runtime, ["logs", "--tail", "40", name]).catch(() => ({ stdout: "", stderr: "" }));
    console.error(`e2e: ${error instanceof Error ? error.message : String(error)}\n${logs.stdout}${logs.stderr}`);
    return 1;
  } finally {
    await stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`e2e: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
```

`playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";
import { E2E_PORTS, GALLERY_PORT } from "./e2e/state.ts";

const ws = process.env.PAP_E2E_WS_ENDPOINT;
// Browsers live in the Playwright container; exposeNetwork tunnels their localhost back to this host (R51).
const connect = ws ? { connectOptions: { wsEndpoint: ws, exposeNetwork: process.env.PAP_E2E_NETWORK === "host" ? undefined : "<loopback>" } } : {};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  expect: { toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.002 } },
  use: { trace: "retain-on-failure", ...connect },
  webServer: {
    command: "pnpm --filter @pap/web exec vite preview --config vite.gallery.config.ts",
    url: `http://127.0.0.1:${GALLERY_PORT}/gallery.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: "chromium", testIgnore: /gallery|phone/, use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${E2E_PORTS.chromium}` } },
    { name: "webkit", testIgnore: /gallery|phone/, use: { ...devices["Desktop Safari"], baseURL: `http://localhost:${E2E_PORTS.webkit}` } },
    { name: "chromium-phone", testMatch: /phone|smoke/, use: { ...devices["Pixel 7"], baseURL: `http://localhost:${E2E_PORTS["chromium-phone"]}` } },
    { name: "webkit-phone", testMatch: /phone|smoke/, use: { ...devices["iPhone 13"], baseURL: `http://localhost:${E2E_PORTS["webkit-phone"]}` } },
    { name: "gallery", testMatch: /gallery/, use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${GALLERY_PORT}` } },
  ],
});
```

`e2e/state.ts`: `E2E_PORTS`, `GALLERY_PORT = 7795`, `DaemonState`, `statePath(project)`, `readState(project)` (as M1 Task 27, four projects).

`e2e/global-setup.ts`: M1 Task 27's `startDaemon`, changed for the checklist: the environment is built like `scripts/smoke-dist.ts` (only `PATH`, `LANG`, a temporary `HOME`, `PAP_HOME`, `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PAP_TEST_PROVIDER_SCRIPT`, `PAP_TEST_WORKER_IMPORT` = the network guard), the daemon is started with `--disable-warning=ExperimentalWarning --import=<network guard>`; the 20 s deadline timer is cleared on every path; an early exit rejects with the last 40 output lines; `pid` must be `> 1` before it is recorded; a failing start of one daemon stops the ones already started and removes their temporary roots (`finally`).

`e2e/global-teardown.ts`: for each state file, `expect`-free guard `if (!(state.pid > 1)) continue;`, `process.kill(-state.pid, "SIGTERM")` in `try`, wait for exit up to 10 s (poll `process.kill(pid, 0)` with a deadline), then `SIGKILL` the group if still alive, then `rmSync(state.root, { recursive: true, force: true })` in `finally`.

`e2e/guards.ts`:

```ts
import { expect, type Page } from "@playwright/test";

/** Collects CSP violations and console errors from the first script on (R74, R118). */
export async function installGuards(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = ((window as unknown as { __pap: { csp: string[] } }).__pap = { csp: [] });
    document.addEventListener("securitypolicyviolation", (event) => store.csp.push(`${event.violatedDirective} ${event.blockedURI}`.slice(0, 200)));
  });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 200));
  });
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
  (page as Page & { __papErrors?: string[] }).__papErrors = errors;
}

/** "Design-system lint clean on every screen", the part a browser has to check. */
export async function expectCleanScreen(page: Page, { coarse = false }: { coarse?: boolean } = {}): Promise<void> {
  const csp = await page.evaluate(() => (window as unknown as { __pap?: { csp: string[] } }).__pap?.csp ?? []);
  expect(csp, "CSP violations").toEqual([]);
  expect((page as Page & { __papErrors?: string[] }).__papErrors ?? [], "console errors").toEqual([]);
  const titled = await page.evaluate(() => [...document.querySelectorAll("[title]")].filter((el) => !(el instanceof SVGElement)).map((el) => el.outerHTML.slice(0, 120)));
  expect(titled, "native title attributes (DESIGN.md §7.1)").toEqual([]);
  if (!coarse) return;
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"], [role="switch"], [role="checkbox"], [role="slider"], [role="separator"][tabindex]')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && (box.width < 43.5 || box.height < 43.5);
      })
      .map((el) => el.outerHTML.slice(0, 120)),
  );
  expect(small, "touch targets under 44 px (DESIGN.md §5)").toEqual([]);
}
```

`e2e/auth.ts`: `ensureSignedIn(page, state)` goes to `/`; on the heading `Create the owner account` it opens `state.setupUrl` and creates `owner` / `correct horse battery staple`; on `Sign in` it signs in; then waits for the shell (`[data-shell]`).

`e2e/fixtures/approval-script.json`: M1 Task 27's script (one `bash` call `echo pap-e2e-ok`, then the text).

`e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { expectCleanScreen, installGuards } from "./guards.ts";
import { readState } from "./state.ts";

test("the setup link opens the owner form, under the CSP, in this engine", async ({ page }, info) => {
  await installGuards(page);
  await page.goto(readState(info.project.name).setupUrl);
  await expect(page.getByRole("heading", { name: "Create the owner account" })).toBeVisible();
  await expectCleanScreen(page, { coarse: info.project.name.endsWith("phone") });
});
```

`package.json` scripts: `"e2e": "node --disable-warning=ExperimentalWarning scripts/e2e.ts"`. `knip.json` root entries gain `"e2e/**/*.ts"`, `"playwright.config.ts"`; `ignoreBinaries` gains `"podman"`, `"docker"`.

- [ ] **Step 4: Run it**

Run:
```bash
pnpm test:unit scripts/e2e-config.test.ts
pnpm build && pnpm --filter @pap/web build:gallery
pnpm e2e --project=chromium --project=webkit --project=chromium-phone --project=webkit-phone e2e/smoke.spec.ts
```
Expected: the unit test passes; the e2e run prints the pull, then `4 passed`, and `podman ps` shows no `pap-e2e-*` container afterwards. If the browser cannot reach `localhost:779x`, rerun with `PAP_E2E_NETWORK=host` and record the outcome in the commit body and in `docs/agents/web.md` (Task 32).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add scripts/e2e.ts scripts/e2e-config.test.ts playwright.config.ts e2e package.json pnpm-lock.yaml tsconfig.json knip.json .gitignore
git commit -m "test(e2e): Playwright in the official container image with daemons on the host"
```

---

### Task 30: Journeys — owner (M1 Task 27), shell on desktop, phone viewports; the CI e2e job

The M1 journey (setup → reload → sign out → sign in → prompt → approval → result, passkey on Chromium) runs on Chromium and WebKit through the new shell (decision 36). The shell journey visits every screen and checks it with `expectCleanScreen`; the phone journey runs on a Pixel 7 (Chromium) and an iPhone 13 (WebKit). Selectors use roles and the DOM's sentence-case text (R121), never CSS text-transform.

**Files:**
- Create: `e2e/owner-journey.spec.ts`, `e2e/shell.spec.ts`, `e2e/phone.spec.ts`
- Modify: `.github/workflows/ci.yml` (job `e2e`), `scripts/e2e-config.test.ts` (the CI case becomes a real test)

**Interfaces:**
- Consumes: Tasks 19–29.
- Produces: the browser exit criteria of M3; CI job `e2e`.

**Risks / rulings needed:** (a) The owner journey selects M2-owned screens by today's labels (`Working directory`, `New session`, `Message`, `Send`, `Approval needed`, `Allow once`); M2 may change them, so P6 re-runs and adjusts after both merge: confirm. (b) CI pulls a large image (~2 GB) per e2e run; with `timeout-minutes: 25` this is the FinOps cost of the browser gate: confirm, or rule caching the image.

- [ ] **Step 1: Write the journeys**

`e2e/owner-journey.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { expectCleanScreen, installGuards } from "./guards.ts";
import { readState } from "./state.ts";

const OWNER = { username: "owner", password: "correct horse battery staple" };

test.describe.serial("owner journey (M1 Task 27, decision 36)", () => {
  test("setup → reload → sign out → sign in → prompt → approval → result", async ({ page }, info) => {
    await installGuards(page);
    const state = readState(info.project.name);
    await page.goto(state.setupUrl);
    await expect(page.getByRole("heading", { name: "Create the owner account" })).toBeVisible();
    await expectCleanScreen(page);
    await page.getByLabel("Username").fill(OWNER.username);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("[data-shell]")).toBeVisible();

    // WebKit keeps the loopback cookie over plain HTTP (ADR 0004).
    await page.reload();
    await expect(page.locator("[data-shell]")).toBeVisible();

    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expectCleanScreen(page);
    await page.getByLabel("Username").fill(OWNER.username);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await page.getByLabel("Working directory").fill(state.cwd);
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.getByLabel("Message").fill("Run the check");
    await page.getByRole("button", { name: "Send" }).click();

    const card = page.getByRole("alertdialog", { name: "Approval needed" });
    await expect(card).toContainText("echo pap-e2e-ok");
    await card.getByRole("button", { name: "Allow once" }).dblclick();
    await expect(page.getByText("The command printed pap-e2e-ok.")).toBeVisible();
    await expect(card).toBeHidden();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("tab", { selected: true })).toBeVisible();
    await expectCleanScreen(page);
  });

  test("passkey enrolment in Settings and sign-in (Chromium virtual authenticator)", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "the virtual authenticator is a Chromium DevTools feature");
    await installGuards(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
    await page.goto("/");
    await page.getByLabel("Username").fill(OWNER.username);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.goto("/settings/account");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByText("Passkey added.")).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(page.locator("[data-shell]")).toBeVisible();
    await expectCleanScreen(page);
  });
});
```

`e2e/shell.spec.ts` (desktop projects; `ensureSignedIn` first; `mod` is `Control` in the Linux container), one `test` each, every one ending with `expectCleanScreen(page)`:
- "⌘K opens the palette and runs a settings item": `Control+K` → dialog `Command palette` → type `appear` → `Enter` → heading `Appearance`, URL `/settings/appearance`.
- "appearance: account scope survives a reload, device scope stays on the device": Mode `Day` → `html[data-theme="day"]`; Density `Comfortable` → `html[data-density="comfortable"]`; `reload()` → both kept and the status reads `Saved to your account`; Reset → toast `Appearance reset` → `Undo` → `data-theme="day"` again; set Mode back to `System`.
- "language switches without a reload": Settings › Language → `Français` → nav entry `Apparence` visible, `html[lang="fr"]`, no navigation happened (a `page.on("framenavigated")` counter stays 0) → back to `English`.
- "tabs and a keyboard-resizable split": create a session (as in the owner journey, without prompting) → two tabs (`New session`, the folder name) → `Alt+Shift+ArrowLeft` selects the other tab → split button → a `separator` with `aria-valuenow="50"` → focus it, `ArrowLeft` ×3 → `aria-valuenow="48"` (1280 px viewport: three 8 px steps on the pane area) → reload → the separator is back with the same value → close the split.
- "⌘B tree and Inbox": `Control+B` → dialog `Sessions` with the working directory's group → click the session row → the dialog closes and the session tab is selected; top bar `Inbox` → dialog `Inbox` with `Nothing waits for you` → `Escape` closes it.
- "a custom shortcut works at once and resets": Settings › Keyboard shortcuts → `Change` on `Open the command palette` → press `Control+Shift+P` → row shows `Custom` → `Escape` the settings focus → `Control+Shift+P` opens the palette → close it → `Reset` the row.
- "? lists the shortcuts": click the page body → `?` → dialog `Keyboard shortcuts` lists `Open the command palette` with `Ctrl` `K`.
- "an unknown address shows the not-found screen": `goto("/nope")` → heading `This page does not exist` → `Go to the start` → home.
- "every settings section renders": visit `/settings/appearance`, `/settings/shortcuts`, `/settings/language`, `/settings/account` with `expectCleanScreen` after each.

`e2e/phone.spec.ts` (phone projects; `ensureSignedIn`):
- "bottom nav, one section at a time, no rail": `nav` `Sections` with `Agents`, `Work`, `Lists`, `Inbox`; no `[data-slot="rail"]`; `Agents` → `No agent yet`; `Lists` → the session tree; `Inbox` → `Nothing waits for you`; `Work` → home; `expectCleanScreen(page, { coarse: info.project.name === "chromium-phone" || await page.evaluate(() => matchMedia("(pointer: coarse)").matches) })` on each, and `expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)` on `chromium-phone` (at least one engine checks the 44 px rule for real).
- "menus open as bottom sheets": the open-items button opens a sheet whose panel's bottom edge is within 2 px of the viewport height.
- "nothing scrolls sideways": `document.documentElement.scrollWidth <= innerWidth` on every section.
- "the viewport is set up for the keyboard": `meta[name="viewport"]` contains `viewport-fit=cover` and `interactive-widget=resizes-content`.

- [ ] **Step 2: Add the CI job**

Append to `jobs:` in `.github/workflows/ci.yml`:

```yaml
  e2e:
    needs: build
    runs-on: ubuntu-24.04
    timeout-minutes: 25
    env:
      PI_OFFLINE: "1"
      PI_TELEMETRY: "0"
      PAP_E2E_RUNTIME: docker
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          persist-credentials: false
      - uses: ./.github/actions/setup
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
        with:
          name: dist
          path: .
      - run: pnpm --filter @pap/web build:gallery
      - run: pnpm e2e
      - if: failure()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: playwright-report
          path: |
            playwright-report
            test-results
          retention-days: 7
```

and turn the `it.todo` of `scripts/e2e-config.test.ts` into `it`. (`scripts/ci-config.test.ts` already pins checkout SHAs and `persist-credentials: false` for every job; it now covers this one too — run it.)

- [ ] **Step 3: Run the suite**

Run: `pnpm build && pnpm --filter @pap/web build:gallery && pnpm e2e --project=chromium --project=webkit --project=chromium-phone --project=webkit-phone && pnpm test:unit scripts`
Expected: owner journey 2 passed on Chromium, 1 passed + 1 skipped on WebKit; shell 9 passed per desktop engine; phone 4 passed per phone engine; smoke 4 passed; the unit tests pass. A WebKit failure on the reload step is a real defect (M1's note on ADR 0004): stop and report it, do not weaken the test.

- [ ] **Step 4: Commit**

```bash
pnpm format
git add e2e scripts/e2e-config.test.ts .github/workflows/ci.yml
git commit -m "test(e2e): owner, shell and phone journeys on Chromium and WebKit, and the CI job"
```

---

### Task 31: Visual regression of the gallery, and the PNG icons

DESIGN.md §14 (and R129): "Playwright screenshots of `/dev/ui` in 3 themes × 2 densities". Baselines are made in the same container image as CI, so fonts and rasterisation match; the snapshot path has no platform suffix (Task 29's `snapshotPathTemplate`). The PNG icons of DESIGN §6.3 (favicons 16/32 on a `--surface` tile, Apple touch 180, PWA 192/512 maskable on the night background) are rendered from the SVG sources of Task 11 by the same browser server, and a unit test catches a stale render.

**Files:**
- Create: `e2e/gallery.spec.ts`, `e2e/__screenshots__/*.png` (18 baselines)
- Create: `scripts/icon-list.ts`, `scripts/render-icons.ts`, `scripts/icons.test.ts`, `apps/web/public/icons/{favicon-16.png, favicon-32.png, apple-touch-icon-180.png, pwa-192.png, pwa-512.png, pwa-maskable-512.png, sources.json}`
- Modify: `scripts/e2e.ts` (`--icons` mode runs the render script against the browser server instead of `playwright test`), `apps/web/index.html` (PNG icon links), `apps/web/src/build-output.int.test.ts`

**Interfaces:**
- Produces: `pnpm e2e --project=gallery` (screenshots), `pnpm e2e -- --icons` (renders icons), `ICONS: ReadonlyArray<{ file: string; source: string; size: number }>` in `scripts/icon-list.ts`.

**Risks / rulings needed:** (a) Screenshots on Chromium only (WebKit would double the baselines; its rendering is covered by the journeys): owner question Q6. (b) 18 PNG baselines (~1–2 MB) live in git: confirm. (c) PWA icons are rendered now and linked by M12's manifest: none.

- [ ] **Step 1: Write the gallery spec and the icon test**

`e2e/gallery.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { expectCleanScreen, installGuards } from "./guards.ts";

const THEMES = ["night", "day", "hc"] as const;
const DENSITIES = ["compact", "comfortable"] as const;
const SECTIONS = ["brand", "primitives", "ai"] as const;

for (const theme of THEMES) {
  for (const density of DENSITIES) {
    test(`gallery in ${theme}, ${density}`, async ({ page }) => {
      await installGuards(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/gallery.html?theme=${theme}&density=${density}`);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      for (const section of SECTIONS) {
        await expect(page.locator(`[data-gallery-section="${section}"]`)).toHaveScreenshot(`${section}-${theme}-${density}.png`);
      }
      await expectCleanScreen(page);
    });
  }
}
```

(`vite preview` sends no CSP: the CSP part of `expectCleanScreen` is trivially empty here; the journeys check the CSP against the daemon.)

`scripts/icons.test.ts`:

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICONS } from "./icon-list.ts";

const at = (path: string) => new URL(`../${path}`, import.meta.url);
const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

describe("icons (DESIGN.md §6.3)", () => {
  it("are PNGs of the declared sizes", () => {
    for (const icon of ICONS) {
      const bytes = readFileSync(at(`apps/web/public/icons/${icon.file}`));
      expect(bytes.subarray(1, 4).toString("latin1"), icon.file).toBe("PNG");
      expect(pngSize(bytes), icon.file).toEqual({ width: icon.size, height: icon.size });
    }
  });
  it("were rendered from the current SVG sources (re-run pnpm e2e -- --icons after editing one)", () => {
    const recorded = JSON.parse(readFileSync(at("apps/web/public/icons/sources.json"), "utf8")) as Record<string, string>;
    for (const source of new Set(ICONS.map((icon) => icon.source))) {
      expect(recorded[source], source).toBe(createHash("sha256").update(readFileSync(at(`apps/web/icons-src/${source}`))).digest("hex"));
    }
  });
});
```

- [ ] **Step 2: Write the renderer**

`scripts/icon-list.ts` (separate, so the unit test never loads Playwright):

```ts
export const ICONS = [
  { file: "favicon-16.png", source: "favicon-tile.svg", size: 16 },
  { file: "favicon-32.png", source: "favicon-tile.svg", size: 32 },
  { file: "apple-touch-icon-180.png", source: "apple-touch.svg", size: 180 },
  { file: "pwa-192.png", source: "apple-touch.svg", size: 192 },
  { file: "pwa-512.png", source: "apple-touch.svg", size: 512 },
  { file: "pwa-maskable-512.png", source: "pwa-maskable.svg", size: 512 },
] as const;
```

`scripts/render-icons.ts`:

```ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { ICONS } from "./icon-list.ts";

const at = (path: string) => new URL(`../${path}`, import.meta.url);

/** Renders the icons with the containerised browser (scripts/e2e.ts --icons passes the endpoint). */
export async function renderIcons(wsEndpoint: string): Promise<void> {
  const browser = await chromium.connect(wsEndpoint, { timeout: 30_000 });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const hashes: Record<string, string> = {};
    for (const icon of ICONS) {
      const svg = readFileSync(at(`apps/web/icons-src/${icon.source}`));
      hashes[icon.source] = createHash("sha256").update(svg).digest("hex");
      await page.setViewportSize({ width: icon.size, height: icon.size });
      await page.setContent(`<style>html,body{margin:0}</style><img width="${icon.size}" height="${icon.size}" src="data:image/svg+xml;base64,${svg.toString("base64")}">`);
      await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
      writeFileSync(at(`apps/web/public/icons/${icon.file}`), await page.screenshot({ clip: { x: 0, y: 0, width: icon.size, height: icon.size } }));
    }
    writeFileSync(at("apps/web/public/icons/sources.json"), `${JSON.stringify(hashes, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const endpoint = process.env.PAP_E2E_WS_ENDPOINT;
  if (!endpoint) throw new Error("run through `pnpm e2e -- --icons`");
  await renderIcons(endpoint);
}
```

In `scripts/e2e.ts`, when `process.argv.includes("--icons")`, spawn `node --disable-warning=ExperimentalWarning scripts/render-icons.ts` (same env) instead of `playwright test`, and skip the build check for `apps/web/dist-gallery` and the daemons (the icons need only the browser).

`apps/web/index.html` adds:

```html
    <link rel="icon" href="/icons/favicon-32.png" sizes="32x32" type="image/png" />
    <link rel="icon" href="/icons/favicon-16.png" sizes="16x16" type="image/png" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />
```

and the build-output test checks the three files exist in `dist/icons/`.

- [ ] **Step 3: Make the baselines and the icons, then check them**

Run:
```bash
pnpm e2e -- --icons
pnpm test:unit scripts/icons.test.ts
pnpm build && pnpm --filter @pap/web build:gallery
pnpm e2e --project=gallery --update-snapshots
pnpm e2e --project=gallery
```
Expected: six PNGs and `sources.json` written; the icon test passes; 18 baselines written under `e2e/__screenshots__/`; the second gallery run passes with no diff. Look at the PNGs before committing (they are the screen's reference from now on).

- [ ] **Step 4: Commit**

```bash
pnpm format
git add e2e/gallery.spec.ts e2e/__screenshots__ scripts/icon-list.ts scripts/render-icons.ts scripts/icons.test.ts scripts/e2e.ts apps/web/public/icons apps/web/index.html apps/web/src/build-output.int.test.ts
git commit -m "test(ui): gallery screenshots in three themes and two densities; rendered PNG icons"
```

---

### Task 32: Bundle budget from real numbers, docs, final gates

Roadmap M3 exit: "the bundle budget is re-set from real numbers". Spec C §7.4: editor, terminal, diff and shiki load lazily; in M3 that means the palette (cmdk) and the gallery stay out of the initial assets, which the build-output test now proves.

**Files:**
- Modify: `budgets.json`, `scripts/check-budgets.ts` (prints the lazy chunks too), `scripts/check-budgets.test.ts`, `apps/web/src/build-output.int.test.ts`
- Create: `docs/agents/web.md`
- Modify: `AGENTS.md` (commands, topic note link)

**Interfaces:**
- Produces: `lazyAssets(distDir: string): Array<{ file: string; gzipKb: number }>` (every `/assets/*.js|css` not in the initial list); the new `initialBundleGzipKb` value.

**Risks / rulings needed:** The headroom rule: budget = measured initial gzip size × 1.10, rounded up to the next KB: confirm the 10 %.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/build-output.int.test.ts`:

```ts
  it("ships no gallery in the production build (ADR 0007)", async () => {
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
Record the printed `initial bundle: <measured> KB gzip`. Set `budgets.json` `initialBundleGzipKb` to `ceil(measured × 1.10)`. Run `pnpm budgets` again: exit 0.

- [ ] **Step 4: Write the topic note and AGENTS.md lines**

`docs/agents/web.md` (≤ 120 lines, what the code does, no claims beyond it): the shell (the URL names the active item; `PANE_RENDERERS`; only the active tab is mounted; the workspace in `pap.workspace.v1`), appearance (two scopes, the boot cache and why the boot script is an external hashed file, the R120 indirection tokens, the theme-selector rule), commands (registry, the dispatcher's bail-outs, `when` keys, reserved chords, where defaults live), i18n (`useT` vs `t`, namespace catalogs, the literal gate and its allowlist, `serverText` until P4), the gates (class coverage and where class lists may live, the compiler gate, `pap/no-native-title`), the e2e setup (podman/docker, `run-server`, `exposeNetwork` or `--network host` as recorded in Task 29, ports 7791–7795, `--update-snapshots`, `--icons`), the measured bundle numbers, and the traps (Safari 16.4: no CSS nesting, `:has()` allowed; IME keyCode 229; AltGr; no native `title`; tokens through utilities only).

`AGENTS.md`: under Commands add `pnpm e2e` (browsers in the Playwright container via podman; needs `pnpm build && pnpm --filter @pap/web build:gallery` first; `PAP_E2E_RUNTIME=docker` in CI) and `pnpm e2e --project=gallery --update-snapshots` (after a deliberate visual change); under topic notes add `docs/agents/web.md`. AGENTS.md stays under 150 lines.

- [ ] **Step 5: Run every gate (the M3 exit)**

Run:
```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm smoke && pnpm --filter @pap/web build:gallery && pnpm e2e && pnpm budgets
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

These need M2's code on `main`. They run on the M3 branch after it rebases on a `main` that already holds M2 (recommended order), or on a follow-up branch if M3 merges first. Each is a normal task (failing test first, gates, Conventional Commit). Models: Sonnet implementer, Sonnet reviewer for all seven.

| # | Task | Files (expected) | Test that proves it |
|---|---|---|---|
| P1 | Remove the M1 token aliases: migrate every `bg-panel`, `border-line`, `*-human*`, `text-on-fill`, `*-attention*`, `text-error` in M2's files to the DESIGN names, then delete the alias block of `tokens.css` | `apps/web/src/features/sessions/**`, `packages/ui/src/tokens.css`, `tokens.test.ts` | `tokens.test.ts` "keeps the M1 utility names" becomes "the M1 aliases are gone"; class coverage passes over the whole web app |
| P2 | Promote M2's feature components (dialog shells for select / input / editor, status bar, widget frame, custom panel) into `packages/ui` as `InputRequestCard`, `StatusBar`, `Widgets`, `CustomPanel` (DESIGN §9.2), with gallery entries and screenshots; M2's call sites switch to them | `packages/ui/src/ai/*`, `apps/web/src/features/sessions/**`, `apps/web/src/gallery/sections/AiSection.tsx`, `e2e/__screenshots__` | gallery "shows every component" picks them up; their own unit tests move with them; the M2 integration tests stay green |
| P3 | The session screen in the shell: M2's screens use `<section>` and `AppShell` owns `<main>`; `max-w-chat` on the transcript; `AuthorGroup`, `Reasoning`, `ToolCard` (detail from the `data-tool-detail` setting), message actions in the transcript; `useT` instead of `t` in `features/sessions`; `useCommand("session.stop")` for Escape; ApprovalCard's scoped answers if M2 has session/always answers; the reconnect banner adds "your drafts stay on this device" once M2's drafts exist | `apps/web/src/features/sessions/**`, `routes/shell/AppShell.tsx`, `MobileShell.tsx`, `ConnectionBanner.tsx` | a shell test: one `main` landmark on `/s/:id`; Escape in a running session stops it (dispatcher + handler); a locale switch re-renders the transcript's labels; the e2e owner journey still passes |
| P4 | Server texts by code (R128): `notice` events and `status` causes carry a stable `code` (+ params) next to the English text; the reducer shows `serverText` by code; the pattern matching of Task 3 stays only as a fallback for an older daemon | `packages/contracts/src/streams.ts`, `apps/daemon/src/modules/sessions/live-session.ts`, `apps/daemon/src/kernel/supervisor/exit.ts`, `apps/web/src/stores/session-reducer.ts`, `apps/web/src/i18n/server-text.ts` | contract test for the new fields; reducer test: a French session shows the French notice for a coded event |
| P5 | R129's reducer items: linear snapshot reduce (a running `Map`, not a `Set` per message); no content dedup for `role:none` fallback refs | `apps/web/src/stores/session-reducer.ts` (+ test) | a 2 000-message snapshot reduces in linear steps (count the key lookups through an injected map); two different `role:none` messages with equal content both stay |
| P6 | Re-run the browser suite on merged `main`: adjust the journey selectors to M2's final screens; re-measure and re-set the bundle budget (M2 adds code) | `e2e/*.spec.ts`, `budgets.json` | `pnpm e2e` and `pnpm budgets` green on merged `main` |
| P7 | Run M3's gates over M2's files and fix what they find: class coverage, literal strings, React Compiler, `pap/no-native-title` | `apps/web/src/features/sessions/**`, `scripts/literal-allowlist.json` only with a reason | the four gates pass over the whole repository |

ETA for P1–P7: 7–9 hours including reviews.

# Model table

Owner's cost rules: Haiku for mechanical transcription, Sonnet by default, Opus reviewer only for security-critical or concurrency-heavy tasks, Opus for the final whole-branch review. Any upgrade beyond this table needs the owner's approval first.

| Task | Implementer | Reviewer | Why |
|---|---|---|---|
| 1 Tokens | Sonnet | Sonnet | transcription plus Tailwind 4 subtleties (named spacing, `@utility`, variants) |
| 2 Design-system gates | Sonnet | Sonnet | AST extraction and the compiler API |
| 3 i18n structure | Sonnet | Sonnet | |
| 4 Icons, feedback, formats | Haiku | Sonnet | code fully prescribed |
| 5 Button, tooltip, kbd | Sonnet | Sonnet | |
| 6 Form controls | Sonnet | Sonnet | Radix wiring |
| 7 Status and structure | Haiku | Sonnet | code fully prescribed, one pattern repeated |
| 8 Overlays | Sonnet | Sonnet | focus return, sheets, toast store |
| 9 Message and conversation | Sonnet | Sonnet | |
| 10 Reasoning, ToolCard, ApprovalCard | Sonnet | Sonnet | |
| 11 Logo | Haiku | Sonnet | exact geometry given |
| 12 Settings module | Sonnet | **Opus** | new permission domain and per-owner documents through receipts, composed into the daemon inside M2's area: an authorization or composition mistake is a security and merge risk |
| 13 Appearance model | Sonnet | Sonnet | pure functions |
| 14 Boot script and applier | Sonnet | **Opus** | runs before the app under the strict CSP (R74) and turns untrusted `localStorage` into DOM attributes and style properties: a slip breaks the CSP or opens CSS injection |
| 15 Appearance store and sync | Sonnet | Sonnet | |
| 16 Keybinding core | Sonnet | Sonnet | |
| 17 Registry and dispatcher | Sonnet | Sonnet | |
| 18 Workspace model | Sonnet | Sonnet | |
| 19 Router and shell skeleton | Sonnet | Sonnet | |
| 20 Tabs and split | Sonnet | Sonnet | |
| 21 Drawers and commands | Sonnet | Sonnet | |
| 22 Palette | Sonnet | Sonnet | |
| 23 Phone shell | Sonnet | Sonnet | |
| 24 Settings screen | Sonnet | Sonnet | |
| 25 Appearance panel | Sonnet | Sonnet | |
| 26 Theme editor | Sonnet | Sonnet | imports untrusted JSON, but through the contracts schema of Task 12 |
| 27 Shortcuts editor | Sonnet | Sonnet | |
| 28 Gallery | Sonnet | Sonnet | |
| 29 Playwright infra | Sonnet | Sonnet | container wiring |
| 30 Journeys and CI | Sonnet | Sonnet | |
| 31 Visual regression and icons | Sonnet | Sonnet | |
| 32 Budgets and docs | Sonnet | Sonnet | the topic note must describe the whole milestone accurately |
| Final whole-branch review | — | **Opus** | owner rule |
| P1–P7 | Sonnet | Sonnet | |

Summary: 32 tasks — 3 Haiku and 29 Sonnet implementers; reviewers are Sonnet except Tasks 12 and 14 (Opus) and the final review (Opus).

# ETA

Observed in M1: about 1–1.5 h per task including review and fix rounds, security tasks longer. Here: 32 tasks × ~1.25 h ≈ 40 h; Tasks 12 and 14 (Opus review) +1 h; container wiring in Tasks 29–31 +3 h (first image pull, `exposeNetwork` vs `--network host`, baselines); final review and its fixes +3 h. **≈ 47 h of agent time (range 42–52 h)**, then P1–P7 7–9 h after both merges. Pipelined with M2 (reviews of one overlapping implementation of the other), the calendar time is set by the slower milestone rather than the sum.

# Open questions for the owner

1. **R120 — DESIGN.md contrast amendments (WCAG 2.x 1.4.11 non-text contrast ≥ 3:1, 1.4.3 text ≥ 4.5:1).** Measured on the validated values:
   - Day focus ring `#FB923C` (R54: you fill in both modes) is **2.15:1** on the day background and 2.26:1 on white. Candidates: the day `--you` text tone `#C2410C` (4.92:1) or `#EA580C` (3.38:1).
   - Borders: day `--border-strong` `#CFC9BC` is 1.57:1 on bg (1.65:1 on surface), night `#3D3657` 1.69:1 (1.56:1 on surface); input and control borders "identify the component" under 1.4.11. Candidates for a separate `--control-border`: day `#958D80` (3.12:1 / 3.28:1) or `#8F877A` (3.37:1 / 3.55:1); night `#6B6485` (3.43:1 / 3.18:1, the night `--text-dim`). Hairline `--border` would stay decorative.
   - Night approval title: `#EC4899` on the attention tint over a surface card is **4.48:1** (4.88:1 over bg). Candidate: title in `#F472B6` (5.96:1).
   - New finding: night and high-contrast **`--attn-ink` `#FFFFFF` on `--attn-fill` `#EC4899` is 3.53:1** (badge counts are small text). Candidate: ink `#110F18` (5.39:1), as the agent fill already uses. (Day `#FFFFFF` on `#DB2777` is 4.6:1, fine.)
   - Options: (a) keep DESIGN as validated (the plan's default); (b) amend with an ADR: the plan routes the focus ring and control borders through `--focus-ring` and `--control-border`, so each amendment is one line per theme in Task 1 plus the presets; (c) amend only where text contrast fails (title, attention ink) and keep the non-text values.
2. **Theme mode × presets.** The plan reads DESIGN §13 / screen 08 as: Mode chooses the side (Night / Day / System); a *dark theme* (Night Control, High contrast, or a custom theme on a night base) and a *light theme* (Day · Papier, or a custom theme on a day base) fill each side. High contrast is therefore a dark-side choice. Confirm, or say how presets and mode combine.
3. **Keybindings scope.** Stored per account on the server (same `settings` module as the appearance), edited in Settings with a JSON view, import and export. T3 keeps a `keybindings.json` file on the server machine. Confirm per account, or choose per device or a file in `~/.pap`.
4. **Default chords the browser does not keep.** Tab next/previous `Alt+Shift+→/←`, close tab `Alt+W` (both inactive inside text fields), split `Ctrl/⌘+\`, settings `Ctrl/⌘+,`; pi-web's `Esc`, `Ctrl+Alt+N`, `Alt+↑/↓`, `Ctrl+Alt+1..9` kept. Confirm or change.
5. **`/dev/ui` "returns 404 in production".** ADR 0007: the gallery is not compiled into production; `/dev/ui` there shows the app's not-found screen (HTTP 200 from the SPA fallback); screenshots use a test-only gallery build. A literal 404 needs one daemon route. Confirm.
6. **Visual regression on Chromium only** (18 baselines: 3 themes × 2 densities × 3 sections); WebKit rendering is covered by the journeys. Confirm, or ask for WebKit baselines too (doubles the images and their upkeep).
7. **First-run stepper of screen 12** (account → passkey → Pi): deferred to M7, where the Pi step (providers) exists; setup stays one step until then. Confirm.
8. **Fonts**: the bundled Manrope and JetBrains Mono, or the system stacks; no arbitrary installed fonts (that needs a browser permission prompt) and never a font CDN. Confirm.
9. **Small visual rulings DESIGN leaves open**: button labels use the HUD label size (10.5 px mono, 600, 0.12em); a 60 % background dim behind modal overlays; the 1–3 s spinner turns while visible (DESIGN §7.2 read as "no idle animation") and stops under reduced motion; on touch screens text inputs use 16 px so iOS does not zoom, above the compact density's 13 px. Confirm each.
10. **CI cost of the browser gate**: the e2e job pulls the ~2 GB Playwright image on each run (≤ 25 min job). Confirm, or ask for image caching.

# Exit criteria (roadmap M3)

Checked without a browser on this host:
- `pnpm lint` clean, including `pap/no-raw-colors`, `pap/no-arbitrary-values`, `pap/no-restyle`, `pap/no-native-title`, `pap/zustand-selector`, boundaries and the 400-line cap.
- `scripts/class-coverage.test.ts` (no unknown classes), `scripts/literal-coverage.test.ts` (no literal UI text), `apps/web/src/compiler-gate.test.ts` and `compiler-pipeline.int.test.ts` (React Compiler on `@pap/ui` and the app) green.
- `packages/ui/src/tokens.test.ts` (themes, densities, selectors, presets), i18n tests (every key in fr, reactive switch), Safari 16.4 floor and no native CSS nesting, build-output CSP checks (no inline script, boot script first, fonts as files, no gallery in production, palette lazy).
- `pnpm typecheck`, `pnpm knip`, `pnpm format:check`, `pnpm test:unit`, `pnpm test:int`, `pnpm build`, `pnpm smoke`.
- `budgets.json` re-set from the measured M3 build; `pnpm budgets` exit 0.

Checked in the Playwright container (podman here, docker in CI):
- Owner journey on Chromium and WebKit (setup → reload → sign out → sign in → prompt → approval → result; passkey on Chromium).
- Shell journey on Chromium and WebKit (palette, appearance persistence, reactive language, tabs, keyboard split, drawers, custom shortcut, help, not-found, every settings section); phone journey on Pixel 7 (Chromium) and iPhone 13 (WebKit).
- On every screen visited: zero CSP violations, zero console errors, no native `title`, and on coarse pointers no interactive target under 44 × 44 px — "design-system lint clean on every screen".
- Gallery screenshots in 3 themes × 2 densities match their baselines.
- CI job `e2e` green.

# Coverage map

| Requirement (roadmap M3, DESIGN.md, brief) | Task |
|---|---|
| DESIGN §3 tokens: Night, Day · Papier, High contrast; §3.4 geometry; replace the M1 subset | 1 |
| §4 typography, self-hosted fonts in `packages/ui` | 1 |
| §5 densities, 44 px targets | 1, 5–8, 29 (guard) |
| §6 logo and wordmark, favicons, PWA icons | 11, 31 |
| §7.1 icons, no native title | 4, 2 |
| §7.2 motion, reduced motion | 1, 4 |
| §7.3 Orca feedback timing | 4, 5 |
| §7.4 focus ring | 1, 5 |
| §8 shell: rail, top bar, tabs, panes, ⌘B drawer, Inbox drawer (decision 25) | 18–21 |
| §8 breakpoints, phone bottom nav, one pane, sheets (D19) | 8, 23 |
| D19 viewport and mobile keyboard | 23 |
| §9.1 owned Radix primitives (+ Collapsible, ADR 0006) | 4–8 |
| §9.2 AI components per S6 with Apache-2.0 attribution | 9, 10 |
| §9.2 `/dev/ui` in 3 themes × 3 densities, not in production (ADR 0007) | 28 |
| §11 en + fr everywhere, no concatenation, server texts | 3, every UI task, P4 |
| §12 contrast per role in the theme editor, confirmation below AA | 13, 26 |
| §13 appearance settings per account and per device, live, reset (decisions 27–28) | 12, 13, 15, 25 |
| §13.1–13.2 custom themes, JSON import/export, derived tokens | 13, 26 |
| §14 no flash before first paint under the strict CSP | 14 |
| Keybindings JSON with `when` + editor (spec C §7.4) | 12, 16, 17, 27 |
| Cmd+K palette (cmdk) | 22 |
| Design-system lint clean on every screen | 2, 3, 29, 30 |
| Shell works on desktop and phone in Chromium and WebKit | 29, 30 |
| Bundle budget re-set from real numbers | 32 |
| Playwright journey dropped from M1 (decision 36, R51) | 29, 30 |
| R120 (open question), R129, R125, R118, R122/R128, IME 229, mono labels, on-fill per role, selector specificity | see "Backlog rulings absorbed" |
| T3 Code and Orca patterns cited per task | 2, 4, 5, 8, 14, 16–18, 20–23, 26, 27, 29 |

# Execution handoff

Plan saved to `docs/plans/2026-10-11-m3-design-system.md` in the `feat/m3-design` worktree. The brief already fixes the method (subagent-driven, pipelined with M2, Opus red-team review of this plan before dispatch). Before dispatching Task 1, the controller rules on the open questions that gate tasks: Q2 (Task 13), Q3 (Task 12), Q4 (Task 16), Q5 (Task 28), and on each task's "Risks / rulings needed" line; Q1 can be answered any time before Task 1's values are final (a later answer is a one-line change per theme).

# Merge order and conflict notes

**Recommended order: M2 first, then M3.** M2 changes the cores (contracts, daemon, runtime, stores, session screens); M3's hunks in those areas are small and additive. M3 rebases once, resolves the hunks below, runs P1–P7 on its branch, and opens its PR with the post-merge work included, so `main` never carries the token aliases or an unadopted shell. If M3 finishes first and the owner wants it merged first, M2's executor resolves the same hunks during its rebase and P1–P7 follow on a branch from `main` right after M2 merges.

| File | M2 (expected) | M3 | Resolution on rebase |
|---|---|---|---|
| `packages/contracts/src/methods.ts` | many new `sessions.*` methods appended | `import { settingsMethods }` + `...settingsMethods,` as the catalogue's first entry | keep both; M3's two lines sit at the top, M2's entries at the bottom |
| `packages/contracts/src/methods.test.ts` | new mutations in the sorted list | `"settings.set"` in the sorted list | union, kept sorted |
| `packages/contracts/src/permissions.ts` | maybe a new domain | `"settings"` | union of `DOMAINS` |
| `packages/contracts/src/index.ts` | maybe new exports | `export * from "./settings.ts";` | union |
| `apps/daemon/src/daemon.ts` | idle release, systemd scopes, new deps | settings module import, migrations source, `...settings.rpc` | keep both; re-run `pnpm test:int apps/daemon/src/daemon.settings.int.test.ts` |
| `apps/daemon/src/modules/*/migrations` | new sessions migrations | `settings/migrations/202610111000_settings.sql` | none (independent tables; timestamps order across modules) |
| `apps/web/src/i18n/en.ts`, `fr.ts` | a `sessions.*` block | four imports at the top and four spreads first in the object | keep both; the `fr` type annotation catches a missing key |
| `apps/web/src/features/sessions/**` | rewritten | untouched (imported by name: `SessionListScreen`, `SessionScreen({ sessionId })`) | if M2 renamed or re-propped them, adapt `routes/shell/pane-renderers.tsx` only |
| `apps/web/src/runtime/**`, `stores/**` | rewritten (R125's stream keying and hidden-tab throttling are M2's) | untouched; M3 reads `getRuntime`, `useConnectionState`, `rpc.call`, `RpcError` | adapt `lib/account-setting.ts` if a signature moved |
| `packages/ui/**` | none (M2 builds feature components on the existing tokens) | rewritten internally; public API of `main` kept | P1, P2 |
| `eslint.config.js`, `knip.json` | maybe entries | elements `web-lib`, `web-gallery`; rule `pap/no-native-title`; browser globals for `apps/web/src/**/*.js`; entries for the boot script, gallery, e2e | union; `pnpm lint && pnpm knip` |
| `.github/workflows/ci.yml` | maybe a job or step | job `e2e` | union; `pnpm test:unit scripts/ci-config.test.ts scripts/e2e-config.test.ts` |
| `package.json`, `pnpm-lock.yaml` | new deps | `@tailwindcss/node`, `@playwright/test`, script `e2e` (root); `radix-ui`, `lucide-react`, `cmdk` (packages) | resolve `package.json` by hand, then take either lockfile and run `pnpm install` to regenerate it; never hand-merge the lockfile |
| `AGENTS.md` | maybe lines | commands and topic note | union (and keep the `next dev`-style generated blocks out, as usual) |

After the rebase: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm smoke && pnpm --filter @pap/web build:gallery && pnpm e2e && pnpm budgets`, then P1–P7.
