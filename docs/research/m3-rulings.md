# M3 implementation rulings

Decisions taken while executing [the M3 plan](../plans/2026-10-11-m3-design-system.md) (2026-10-11 → 2026-10-12), including the post-merge tasks P1–P7 run after M2 merged: the pre-dispatch ledger M3R1–M3R135 first, then the rulings made during execution from task reviews, re-reviews and the final reviews. They override the plan text where they differ; the specs and DESIGN.md stay the authority.

Owner decisions taken during execution:
- 2026-10-12: M2 merges first (`--no-ff`), M3 rebases on it, then runs P7 → P3 → P2 → P1 → P4 → P5 → P6 before its own merge.
- 2026-10-12: M3 merged into main (`--no-ff`) after a green clean-env gate; initial bundle 194.7 KB gzip, budget kept at the owner's 200 KB ceiling (E41).

# M3 rulings ledger (pre-dispatch, 2026-10-11)

Source: `.worktrees/feat-m3/docs/plans/2026-10-11-m3-design-system.md` ("Rulings (pre-dispatch)" under each task), from the red-team review (`.superpowers/redteam-m3.md` §6), the owner decisions of 2026-10-11 and the M2 ⇄ M3 cross-plan agreements. Format: `M3R<n> [tasks] decision — why — cost if wrong`. Items marked "discovered during implementation" are the only open ones; the implementer reports, the controller rules.

M3R1 [1a] R120 = option (b): ADR 0012 + DESIGN.md §3/§7.4 amendment in Task 1a, every amended value and ratio asserted by tokens.test.ts — owner M3-Q1 — low: values are one line per theme, tests name them
M3R2 [1a, 6] focus-ring, control-border, attn-title are theme tokens (night #fb923c/#6b6485/#f472b6, day #ea580c/#8f877a/#be185d, hc #fb923c/#8a8a8a/#f9a8d4); attn-ink #110f18 in night+hc; controls use border-control-border, hairline border stays decorative — owner M3-Q1 values, WCAG 1.4.11/1.4.3 — low: preset edits, contrast tests catch regressions
M3R3 [1a] High-contrast inks, tints, lines, you-text, diff tones derived by DESIGN §13.2 (fills = night), no ADR — §3.3 keeps night fills, §13.2 derives the rest — low: preset values change
M3R4 [1a] Comfortable --space-6 repeats 32 px — DESIGN lists five steps for comfortable — low: one value
M3R5 [1a, 13] pap/no-raw-colors ignores only presets.ts (1a), contrast.ts and derive.ts (13) — colour data and colour math, each pinned by tests (M3-RT-02) — low: a raw colour could slip into those three files
M3R6 [1a] Keep @theme inline (DESIGN §14 says static), reason written in tokens.css and web.md — subtree theming (gallery frames, Mark mode) needs utilities to read var(--x) in place (M3-RT-37) — low: a later "fix" would break subtree theming, tests show it
M3R7 [1b] Named --spacing-* keys expected to compile; else one @utility per listed class in utilities.css (discovered during implementation) — the compile test pins the outcome either way — low: a utility list
M3R8 [1b] R118's Safari 16.4 WebSocket CSP check not done in M3; ws: true and fonts-as-files tests kept — no browser (owner C1), Playwright WebKit is not Safari 16.4 (M3-RT-36) — medium: a real Safari 16.4 could refuse the socket; fallback is a daemon change
M3R9 [2] Class-coverage reads only className, cn() and UPPER_CASE *_CLASSES/VARIANTS/SIZES/TONES/STYLE/RING constants — plan convention, AST extraction stays exact — low: a class list elsewhere goes unchecked
M3R10 [2] A class is known only when a compiled rule's selector starts with exactly that class (classRule) — substring checks pass typos and fragments (M3-RT-03) — low: a missed exotic selector form shows as a false finding, fixed in the regex
M3R11 [2, 3] Class and literal gates skip apps/web/src/features/sessions until P7 removes the exclusion — a red gate over M2-owned files would block M3 tasks (M3-RT-24) — low: M2 findings wait for P7
M3R12 [2] Compiler gate passes babel-plugin-react-compiler as an imported function — Babel resolves plugin names from the repo root where it is not installed (M3-RT-04) — low: verify the default export in the pinned .d.ts
M3R13 [3] IDENTICAL_IN_FR may name future keys; M2 adds no fr==en key; rebase re-runs i18n.test, P7 adds any identical M2 key with a reason — agreement 4 — low: one failing test after rebase
M3R14 [3] Catalog spreads leave M2's sessions (M2) block untouched; M2 keeps all its keys in that block — agreement 4 — low: textual conflict only
M3R15 [3, 24] Language stays per device (pap.locale in localStorage) — owner R3-3 — low: moving it to the account later is additive
M3R16 [4] lucide names may change; Icon* aliases are the stable API — upstream renames between versions — none
M3R17 [4] Spinner turns while visible (1–3 s, bounded), static under reduced motion — DESIGN §7.3 asks for it, §7.2 targets idle animation — low: one class
M3R18 [4] lucide-react is a dependency of @pap/ui only; the web app imports glyphs through @pap/ui — a web dependency would be unused for knip (M3-RT-25) — none
M3R19 [4, 7] formatCost/formatDuration never print NaN; ProgressBar and Meter report aria-valuenow clamped to their range — M3-RT-38 — low
M3R20 [5] Button labels use the HUD label (10.5 px mono, 600, 0.12em) — owner M3-Q9 — low: one class
M3R21 [5] Button sm is a fixed 24 px row; 44 px under pointer: coarse stays — DESIGN control heights 26/32; sm is for dense rows — low
M3R22 [5] Task 5 edits M2-owned SessionScreen.test.tsx lines 245-246 (bg-panel→bg-surface, border-error→border-err); listed in both conflict tables; take M2's version at rebase and re-apply — agreement 5, M3-RT-05 — low: two assertions
M3R23 [6] Text inputs use 16 px on coarse pointers (iOS zoom) — D19, T3; owner M3-Q9 — low
M3R24 [6] ToggleGroup item role per pinned Radix (radio or aria-pressed), selector follows, assertions kept (discovered during implementation) — Radix versions differ — none
M3R25 [7] OpenTab close button outside the tab (tabIndex -1); Delete on a focused tab closes it; tab.close everywhere — WAI-ARIA tabs pattern, red-team §6 — low
M3R26 [7] ADR numbers: 0010 Collapsible, 0011 /dev/ui, 0012 R120 (M2 holds 0006-0009) — agreement 2, M3-RT-23 — low: renames only
M3R27 [8, 22] On phones centred dialogs, the palette and menus become bottom sheets — DESIGN §8, T3 bottomStickOnMobile — low
M3R28 [8] 60 % background dim behind modal overlays — owner M3-Q9; modality cue DESIGN does not specify — low: one class
M3R29 [8] If Radix focus return needs a frame in happy-dom, await settle(); never drop the assertion (discovered during implementation) — test environment timing — none
M3R30 [8] Toast store gets resetToastsForTests (not in the package index); the app's Toaster reads useT so its close label follows the language — order-dependent tests, R128 reactivity (M3-RT-26) — low
M3R31 [9] Apache-2.0 per S6's full recipe: notice, commit 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd (recorded in s6.md line 4), headers, canonical text in LICENSES/Apache-2.0.txt (sha256 pinned) — S6 recipe, R53, M3-RT-06 — medium: licence non-compliance if skipped
M3R32 [9] Message keeps M1 props/DOM; model text renders through Markdown as its child — agreement 5, S6 "slot" — low
M3R33 [9] Message.test M1 class assertions replaced by DESIGN names; behaviour assertions kept — M1 names no longer emitted (M3-RT-27) — none
M3R34 [10] ApprovalCard buttons in DESIGN order (Deny first) — DESIGN §9.2; M2 tests select by name — none
M3R35 [10] ApprovalCard API = answers + labels + onChoose (one callback per click), M1 props as adapter, deny always offered; P3 swaps M2's ApprovalDialog and adds the ApprovalAnswer ui≡contracts type test — agreement 6, M3-RT-07 (M2 ships session/always now) — medium: P3 rework or a double send if wrong
M3R36 [10] Approval header sentence case in the DOM, uppercase via label-hud, colour text-attn-title — R121, agreement 6, ADR 0012 — low
M3R37 [10] ToolCard follows the detail setting until the person toggles it — later setting changes were ignored (M3-RT-38) — low
M3R38 [10b] Markdown = react-markdown + remark-gfm, skipHtml, safeHref (absolute http/https/mailto only), links target _blank rel noopener noreferrer, images as alt text, text >100 000 chars plain — untrusted model text, zero telemetry, CSP img-src (owner R3-1) — high if loosened: HTML or script injection through model output
M3R39 [10b] Highlighting = shiki core + JavaScript regex engine + css-variables theme, fixed language list loaded per language, code >20 000 chars plain; WebAssembly stubbed to throw in the test — CSP R74 has no 'wasm-unsafe-eval' (owner R3-1) — medium: a WASM engine would need an ADR and a CSP change
M3R40 [10b] Code colours: keywords --agent, comments --text-muted italic, the rest --text, set on [data-slot="code-block"] — DESIGN §2 (hues never decorative; code is agent output) — low: one CSS block
M3R41 [10b, 25] Markdown lives in packages/ui/src/ai as Message's body slot; Task 25's preview and Task 28's gallery use it; P3 adopts it in M2's transcript — S6, agreement 9 — low
M3R42 [10b] react-markdown, remark-gfm, shiki pinned exactly in @pap/ui; minimumReleaseAge waited for, never bypassed; an install script → stop and ask (discovered during implementation); shiki subpaths and react-markdown props verified against .d.ts — R56, R36, no node_modules at planning — medium: a wrong import path costs a fix round
M3R43 [10b] Markdown wrapper chunk < 3 KB gzip (build test); renderer and highlighter chunk sizes in the commit body — owner R3-5 bundle target — low
M3R44 [11] PNG favicons, Apple touch and PWA icons deferred to M12; Safari has no tab icon meanwhile; SVG sources ship now; build output references only /assets/* and /favicon.svg — owner C1 removed the renderer — low: cosmetic in Safari
M3R45 [12] settings module, contracts file and permission domain in M2's areas, one-line shared hunks, Opus review — owner R3-8, agreement 13 — low: trivial conflicts
M3R46 [12] Keybindings per account on the server; digits/punctuation by physical key — owner M3-Q3, R3-7 — low
M3R47 [12] settings.set on a read-only database fails like every write (read_only) — R-level consistency with other writes — none
M3R48 [12] Compare-and-set: settings.set carries baseRevision (0 = create); one-statement UPDATE … AND revision=$base / INSERT … ON CONFLICT DO NOTHING; miss → conflict, stored document unchanged — owner R3-4, M3-RT-01 — high if wrong: silent loss of custom themes and settings
M3R49 [12, 26] Every AccountAppearance field has .default(); preset ids night/day/hc refused as custom ids and skipped by newThemeId — additive fields must read old documents; a custom "day" shadowed the preset (M3-RT-09) — medium: settings reset or an unreachable preset
M3R50 [12] 128 KiB cap test crosses the cap with two-byte characters and asserts the size first — the ASCII version could never exceed the cap (M3-RT-08) — low
M3R51 [12] Migration stamp 202610111000_settings.sql; the branch merging second re-stamps after main's newest stamp at its rebase — migrate.ts refuses out-of-order stamps (agreement 1, M3-RT-10) — high if forgotten: daemon refuses to boot
M3R52 [13] Mode picks the side; dark side = Night, High contrast or night-based custom; light side = Day or day-based custom — owner M3-Q2, screen 08 — low
M3R53 [13] Derivation ratios (8/13/22/35/38/55/58 %) are pap's numbers for DESIGN §13.2, documented in web.md — DESIGN gives rules, not ratios — low
M3R54 [13] Account documents parsed field by field: bad/missing field falls back alone, valid custom themes kept (dedupe, ≤16, ≤64 read), vanished side theme falls back; DEFAULT_ACCOUNT = contracts' defaults — owner R3-4, M3-RT-01 — high if all-or-nothing: one new field wipes a user's settings
M3R55 [13] Custom themes derive control-border and focus-ring (3:1 on bg and surface) and attn-title (4.5:1 on tint over surface) — ADR 0012 must hold for custom themes too — low: derivation tweak
M3R56 [14] Boot plugin relies on Vite 8 transformIndexHtml tag injection and emitFile in generateBundle, pinned by the build-output test — no inline script under R74 — low
M3R57 [14] Boot script allowlists BOOT_VAR_NAMES (theme tokens + size vars) with hex/px values and known data-* words; the first apply starts from inline appearance vars so stale ones are removed; other inline vars untouched — M3-RT-11 — medium: stale colours for a session or a collapsed shell
M3R58 [14] Optional catch binding (ES2019) in the boot script — unused bindings fail ESLint (M3-RT-12); within Safari 16.4 — none
M3R59 [14] Opus reviewer for Task 14 — pre-paint script turns untrusted localStorage into DOM under strict CSP (owner X2) — cost of one Opus review
M3R60 [15] Account document engine: hold until first load settles, no save after load-error until a later load succeeds, one save at a time from the latest revision, conflict → re-read + merge dirty fields + one retry, other failures wait for next change/sync (R105), re-sync keeps a pending change — owner R3-4, M3-RT-01 — high if wrong: lost or overwritten user data across tabs/devices
M3R61 [15] Device settings and language never sent to the server — DESIGN §13, owner R3-3 — none
M3R62 [15, 25] Reset to defaults keeps the custom theme library; Undo restores both scopes — owner R3-2 — low
M3R63 [15] No live cross-tab refresh in M3; CAS prevents lost updates; other tabs update at next connect/reload — R125 second stream deferred — low: stale view in another tab until reload
M3R64 [15] accountStatus semantics: local / load-error / saving / saved / error — the UI must not overclaim (DESIGN §11) — low
M3R65 [15] Opus reviewer for Task 15 — persisted user data, lost updates, async ordering (owner X2, red-team §4) — cost of one Opus review
M3R66 [16a] Shifted symbols match through the layout key only; a physical-key match needs exact Shift (/ never fires on Shift+/) — M3-RT-28 — low
M3R67 [16a] Ctrl+Alt is AltGr on Windows: Ctrl+Alt+1..9 and Ctrl+Alt+N do not fire there — pi-web's accepted trade-off — low
M3R68 [16a, 27] Recorder stores digits and punctuation by physical key (AZERTY Ctrl+1 → mod+1); letters by layout key — owner R3-7, account bindings shared across layouts — low
M3R69 [16b] Default chords: Alt+Shift+←/→ tabs, Alt+W close, Mod+\ split, Mod+, settings; pi-web's Esc, Ctrl+Alt+N, Alt+↑/↓, Ctrl+Alt+1..9 kept — owner M3-Q4; browsers keep Ctrl+Tab/W — low
M3R70 [16b] A bare printable key never fires in a text field unless its when names editableFocus — Orca fileSearchClaimsTextKey; prevents typing into shortcuts — none
M3R71 [16b] Every default chord has !panelFocus, Escape also !overlayOpen; matchingCommands skips rules in panelFocus unless their clause names panelFocus — agreement 7, owner R3-6, M3-RT-16 — medium: Escape could stop a run from inside an extension panel or a menu
M3R72 [16b, 21] mod+b closes the tree drawer: !panelFocus && (!dialogOpen || treeOpen), treeOpen read from the shell through a ref — the drawer is itself a modal (M3-RT-30) — low
M3R73 [16b] Reserved chords include Ctrl+1..9 and (off Apple) Alt+1..9; the palette binds no digit chord — browsers keep them (M3-RT-31) — low
M3R74 [16b] conflictsOf stays quadratic over ≤ defaults + 256 rules (< 80 000 comparisons) — bounded by the contract cap — none
M3R75 [17a] Dispatcher ignores auto-repeat for every command — prevents runaway tab cycling (T3) — low
M3R76 [17a] One capture-phase window listener; panels and menus are protected by context keys, not stopPropagation; tooltips are not overlays — capture runs before element handlers (agreement 7) — medium: keys stolen from panels if the context is wrong
M3R77 [17a] Escape unclaimed until P3 registers session.stop — M2's screen owns the handler — none
M3R78 [17b] Keybindings reuse Task 15's CAS engine; the list is one field (this device's list wins only if it changed here) — owner R3-4 — medium: rule loss if merged wrongly
M3R79 [17b] Local cache and server copy read through parseRules (valid entries, ≤256, one keybindings_invalid line); a newer pap's longer list would be cut — M3-RT-29, contract cap — low: no newer version exists
M3R80 [17b] Shortcuts help is a lazy chunk mounted behind LazyBoundary (Task 21) — owner R3-5 bundle target — low
M3R81 [18] At 24 tabs, opening another closes the oldest inactive tab (nothing deleted) — DESIGN §8: closing deletes nothing — low
M3R82 [18] Only the active tab is mounted; switching remounts the session screen — one feed per session (R125), bounded memory — low: resubscribe cost
M3R83 [18] Layout remembered per open item until lanes (M9) — lanes do not exist yet — low
M3R84 [18] workspace-store gets its own test for refused storage (in-memory kept, storage_refused reported once) — checklist: errors never silent — none
M3R85 [19a] web-routes may import @pap/contracts (types) — sessions-cache, session-groups, palette-items, item-title need SessionSummary (M3-RT-14) — none
M3R86 [19a] Router defaultErrorComponent = translated RouteError with Reload; root-route coverage discovered during implementation (fallback: AppShell boundary) — TanStack's default screen is untranslated (M3-RT-15) — low
M3R87 [19a] Shell imports SessionListScreen/SessionScreen by name; only pane-renderers.tsx adapts at rebase — M2 may rename — low
M3R88 [19a] No <main> in the shell until P3 — M2's screens carry their own <main> — none
M3R89 [19b] Reconnect banner says only "Reconnecting…" until P3 adds the drafts line — M2 drafts not on main yet (DESIGN §12) — none
M3R90 [19b] Top-bar project switcher deferred to M4 — no projects yet — none
M3R91 [19b] Rail: logo, Settings, account menu; agent avatars in M11 — no agents yet — none
M3R92 [19b] Socket-open syncs are fire-and-forget with reporting .catch — they settle their own failures into statuses — none
M3R93 [20] Below 640 px of pane area the split shows the first pane only — 2 × 320 px minimum (DESIGN §8) — low
M3R94 [20] No middle-click or drag reorder in M3; Delete or tab.close closes — scope — none
M3R95 [20] workspace index re-exports only names imported at each task — knip per task (M3-RT-13) — none
M3R96 [21] Tree groups sessions by cwd until M4 projects — no projects yet — none
M3R97 [21] Inbox empty state states its purpose, promises no date — DESIGN §11 never overclaim — none
M3R98 [21] Tree shows 200 rows and "N more, use ⌘K" — bounded rendering; FTS5 is M4 — low
M3R99 [21, 22] Every lazy chunk mounts through LazyBoundary + useRetryableLazy (lib/lazy.tsx): stale chunk → panel closes, toast with Reload, next open retries; web-lib may import @pap/ui — M3-RT-15, owner R3-5 — medium: a stale chunk would otherwise blank the shell
M3R100 [22] FTS5 transcript hits in ⌘K arrive with M4 — roadmap — none
M3R101 [22] No digit chords in the palette — browsers keep Ctrl/⌘/Alt+1..9; the happy-dom test would lie (M3-RT-31) — none
M3R102 [23] Chat/Review/Term switch absent until M8/M9 — only chat exists — none
M3R103 [23] Phone "Agents" tab is an empty state until M11 — no agents yet — none
M3R104 [23] interactive-widget=resizes-content for Android; iOS relies on the viewport hook — T3, pw — none
M3R105 [23] Phone top bar's Mark is decorative (no link, aria-hidden) — no small tap target (M3-RT-35 point) — none
M3R106 [24] First-run stepper deferred to M7 — owner M3-Q7; Pi step needs M7 — none
M3R107 [24] Connected devices are M5's; Account shows username, passkeys, sign-out — spec C §4.4 roadmap — none
M3R108 [24] Login throttle note states the real behaviour: 1 s from the first failure, doubling to 1 min, per address and account, reset after 5 min — owner R3-9, apps/daemon/src/modules/auth/throttle.ts — low: copy only
M3R109 [24] Settings screen (all sections) is one lazy chunk through LazyBoundary — owner R3-5, agreement 10 — low
M3R110 [25] Fonts: bundled Manrope/JetBrains Mono or system stacks; no CDN, no installed-font access — owner M3-Q8, zero telemetry — low
M3R111 [25] Size sliders UI 12–16, chat 13–18, code 11–16 px, each with "follow density" — red-team §6 accepted — low
M3R112 [25] Chat width Full (default) / Wide 64rem / Narrow 48rem — decision 28 — low
M3R113 [25] Reset keeps custom themes; status line silent for local, never claims more than the document knows — owner R3-2, DESIGN §11 — low
M3R114 [26] Deleting the custom theme in use → that side back to its preset, with Undo — red-team §6 accepted — low
M3R115 [26] Native colour input next to a hex field — Safari 16.4 supports it — none
M3R116 [26] Duplicate & edit from a preset uses its fills (presetRoles) for agent/you/attn — text tones as roles made a dark-orange primary (M3-RT-32) — low
M3R117 [26] Theme editor is a lazy chunk opened through LazyBoundary — owner R3-5 — low
M3R118 [26] Imported theme files: size, then JSON, then the contracts schema; only hex reaches a style — Review Focus 3, untrusted input — high if loosened: CSS injection
M3R119 [27] Conflicts are warnings; reserved chords refused by the recorder, warned in JSON — T3 behaviour; reserved chords never fire — low
M3R120 [27] when edited in JSON only; a recorded chord keeps the command's default when; JSON rules without panelFocus still skip panels — scope; agreement 7 protection survives rebinding — low
M3R121 [27] Shortcuts editor ships inside the lazy Settings chunk, not its own — only shown inside Settings (owner R3-5) — none
M3R122 [28] /dev/ui in production = SPA not-found (200), ADR 0011, no daemon route — owner M3-Q5 — low
M3R123 [28] Gallery overlays open from buttons — no screenshots in M3 — none
M3R124 [28] Standalone gallery build deferred with visual regression; reviver applies M3-RT-33 — owner C1 — none in M3
M3R125 [28] DESIGN §5 44-px rule checked as classes over the gallery (element or two ancestors carry pointer-coarse size/min-h/h-11; hidden skipped) — no browser in M3 (owner C1) — medium: classes present but layout still too small, caught only by the deferred probe
M3R126 [32] Final budget = ceil(measured × 1.10) if ≤ 200 KB gzip; above 200 → owner decides before any commit; provisional values replaced — owner R3-5, agreement 10, M3-RT-19 — medium: silent budget creep if skipped
M3R127 [32] docs/agents/web.md ≤ 120 lines, deferred checks described as deferred — no overclaiming (checklist) — low
M3R128 [32] AGENTS.md: topic note link only, no e2e command — owner C1 — none
M3R129 [P7] P7 first: remove both scan exclusions, fix M2 findings, no allowlisting without a reason — findings feed P1–P3 (agreement 14) — low
M3R130 [P3] P3: ApprovalCard choice API, ToolCard for ToolRow, Markdown for agent text, data-terminal-input on M2's panel, live regions, session.sendOther (mod+shift+enter, sessionFocus && !panelFocus), drafts line, ApprovalAnswer type test — agreements 6, 7, 9, 14; M3-RT-21 — medium: duplicated components or broken keys after merge
M3R131 [P2] P2 promotes exactly InputRequestCard, StatusBar, Widgets, CustomPanel; QueueStrip and Minimap stay features; gallery entries, no screenshots — DESIGN §9.2, agreement 14 — low
M3R132 [P1] P1 after P3/P2; grep M2 tests for M1 class names first; drop ApprovalCard M1 props only when unused; cn/once/FOCUS_RING stay — avoid double edits (M3-RT-21), agreement 5 — low
M3R133 [P4] P4 targets M2's split emitters/reducer as on main, keeps the pattern fallback — M2 restructures live-session and the reducer — low
M3R134 [P5] P5 first checks whether M2's entry-id rows already resolved R129 — may be moot — none
M3R135 [P6] P6 = bundle re-measure only; above 200 KB gzip the owner decides — agreement 11, owner C1 — medium: budget creep if skipped

# Execution rulings

Format: `E<n> [task] ruling` (copied from the execution ledger; each settles a review finding or an open question).

E1 [-] code highlighting uses the agent colour only (keywords violet, comments muted, rest plain) — plan-fix decision under DESIGN "hues are never decorative", accepted — cost if wrong: a later restyle of Fence (low).
E2 [-] the 44-px coarse-pointer rule is checked headless as CSS classes over the gallery, PNG icons move to M12 with the manifest — consequence of C1 — cost if wrong: a real-size regression only caught by hand (low).
E3 [-] the compiler gate also excludes M2-owned features/sessions via M2_OWNED_UNTIL_P7 (SessionListScreen try/finally bailout) — same rule as the class/literal scans (cross-plan agreement 8, P7 removes it) — cost if wrong: an M2 compiler bailout surfaces only at P7 (low)
E4 [-] literal gate keeps skipping apps/web/src/gallery/ (dev-only, not shipped per ADR 0011; plan-mandated) with a one-line comment saying why — cost if wrong: untranslated gallery labels (none for users)
E5 [-] i18n.test.ts → .tsx rename stands (JSX needs .tsx); M2 does not edit i18n.test.ts (agreement 4: no fr==en keys) — merge note already recorded — cost if wrong: one modify/delete conflict at rebase (low)
E6 [-] fix both despite the prescribed code — M3R19 (never NaN / never out of range) is binding over the brief's code; the early-timer clamp `Math.max(clock.now(), since + mark)` keeps the brief's behaviour on exact clocks — cost if wrong: none
E7 [-] DESIGN §7.4 (focus ring never removed), M3R19 (never NaN / out of range), the 44-px coarse rule and the checklist (a test per guard) bind over the brief's prescribed OpenTab/Meter/Badge code — cost if wrong: none
E8 [-] fix now (resume Task 8 implementer) before Task 11 — a flaky test hides regressions — cost if wrong: none
E9 [-] physical key only when the layout key is unusable or is itself a digit/punctuation character; a usable letter or named layout key is kept (R3-7 intent: layout-independent digits/punctuation, letters by meaning) — cost if wrong: letters on exotic layouts match by layout (low)
E10 [-] Cmd++ on the main-row + records as mod+shift+= (punctuation by physical key, owner R3-7); the UI label shows ⌘⇧= — accepted — cost if wrong: a dedicated + key on other layouts (e.g. German BracketRight) doesn't match a binding recorded on the Equal key (low)
E11 [-] budgets.json provisional value may not exceed the owner's 200 KB ceiling (R3-5); with 197.9 KB measured and Tasks 20–23 still adding eager code, the initial chunk must come back down now — identify the +35 KB and lazy-load what first paint doesn't need (menus' content, tooltips' portal, rarely used icons…), target ≤ ~185 KB, budget set to measured × 1.05 capped at 200 — cost if wrong: one fix round (low); otherwise the owner is asked before the next eager task
E12 [-] overlays leave the eager barrel — `Menu` and `Dialog` (and their Radix stacks) move to a lazy subpath entry `@pap/ui/overlays`; IconButton's Tooltip content is loaded on first pointerenter/focus (TooltipProvider stays eager); budgets.json initialBundleGzipKb = measured × 1.05, never above 185 here (200 hard ceiling); every later M3 task that needs Dialog/Menu/Sheet/Drawer (21 tree drawer, 22 palette + ShortcutsHelp, 24–27 settings) imports them from `@pap/ui/overlays` inside a lazy boundary — CARRY to Tasks 20–28 — why: owner R3-5 bundle ≤ 200 with headroom for Tasks 20–23 — cost if wrong: first open of a menu/tooltip waits for a small chunk (~tens of ms on LAN)
E13 [-] sessions cache also refreshes when the active item is a session id missing from the list (bounded: at most one refresh per missing id per open) — cost if wrong: one extra sessions.list (none)
E14 [19b] TooltipProvider pass-through (skip-delay lost) accepted — cost: every tooltip waits 400 ms (cosmetic)
E15 [-] split falls back to home when there is no other tab and the active item isn't home (brief intent, no self-split) — cost if wrong: none
E16 [21] bundle provisional budget 194 accepted, vite.config unchanged (reviewer tried 6 Rolldown codeSplitting variants: 184.16–239.26 KB, none safe); real delta = +3.1 KB code + 2.7 KB fragmentation (9 initial JS files). CARRY to Task 32: re-measure, consider pinning initial JS file count in the int test
E17 [22] palette.toggle excluded from its own list (selecting it would close as it opens); fr plural treats 0 as singular
E18 [23] MobileShell lazy behind useIsPhone if phone-only code adds > ~2 KB gz to desktop initial; TabSwitcher lazy (overlays)
E19 [23] phones have no keyboard and no rail → settings/sign-out unreachable; the phone top bar gets a palette (search) button opening the palette (which lists settings + sign-out) — fix in round 1
E20 [23] data-shell="mobile" set on <html> while MobileShell is mounted (CSS scoped to html[data-shell=mobile], with fallback); one --bottom-nav-height property for nav + toast offset; badge label with count via Intl.PluralRules
E21 [24] @pap/ui had no "sideEffects" → barrel re-exports made every primitive statically reachable from the entry; added "sideEffects": ["*.css"] to packages/ui/package.json → initial 11 files ≈ 189.9 KiB gz (below the pre-task 190.4/13), Select only in SettingsScreen chunk. Pin with a build-output int case (data-radix-select-viewport absent from initial JS). Owner not asked: no ceiling crossing remains
E22 [24] always-open lazy panes never auto-retry unbounded — bounded auto-retry (if any) then an in-pane failure state with Retry (or the stale-chunk screen); a reusable LazyPanel mode / pane wrapper for Tasks 25 and 27
E23 [25] Settings-only strings move to a lazy catalog (catalog/settings-screen.ts) registered at Settings chunk evaluation via i18n registerCatalog (MessageKey keeps them at type level via import type); source-scan guard that lazy keys are used only inside the Settings chunk; build-output lazy-only marker for a settings-screen string. Budget stays 194; still above → BLOCKED → ask owner
E24 [25] Undo restores the fields the reset changed and never customThemes (reset keeps them; avoids wiping a theme edit made within 5 s once Task 26 exists)
E25 [26] revoke via an injectable scheduler, default setTimeout 40 s (FileSaver.js precedent); Undo never silently no-ops (re-add under a fresh id or toast); saving an edit of a theme deleted meanwhile never closes as success
E26 [27] editor-only strings → catalog/settings-screen.ts (not eager commands.ts); ShortcutsEditor NOT exported from the eager features/commands barrel (imported from its own file) + build-output lazy marker; shared download helper extracted from theme-io (scheduled revoke); budget: >194 → provisional min(×1.05, 200), >200 → BLOCKED
E27 [27] conflict = warn unless provably exclusive (an atom top-level conjunct in one clause and negated top-level conjunct in the other; any ||/parens → warn); empty-valid import never applies silently; imports get Undo like Reset all
E28 [28] gallery strings leave the eager catalog (lazy catalog registered by the gallery module); build-output asserts a gallery marker + string absent from EVERY prod asset; a primitive failing the 44-px class probe is fixed, never the probe weakened
E29 [28] document the portal limit (ADR 0011 + visible gallery note) — no portal-container plumbing for a dev-only tool; prod dev-ui item takes the not-found title
E30 [32] final budget = min(ceil(measured × 1.10), 200); measured ≈ 192.7 → ×1.10 ≈ 212 → capped at 200 = the owner's own target (agreement 10 asks the owner only above 200); flagged in the final report; P6 post-merge re-measure (M2 + M3) is where an owner question may arise
E31 [32] measure the contracts sideEffects lever (keep only if it shrinks and tests pass); no zod/mini, no lazy MobileShell, no JS file-count pin; docs/agents/web.md Modify (exists since Task 13)
E32 [M3 final] I5 fixed now (three-way merge by theme id, base = last adopted server value); keybindings list same shape → documented limit, carried
E33 [M3 final] lever 1 applied now on M3 — SessionScreen lazy via LazyPane (merged tree 195.2 → 190.5); lever 2 → M2 carry (keep stores lean, no overlays outside features/sessions)
E34 [M3 final] N3 → re-id the local theme on a same-id/different-content collision (canonical compare), selection follows; server-without-document keeps cached themes as local adds; cap drop shows a notice
E35 [M3 final] R2-1 cap-drop notice → reviewer's rule (edited here AND merged list > 16 before parseAccount); R2-2 → doc line (narrow guarantee for cache-only themes), no first-contact write; R2-6 theme-ids.ts split (−988 B); R2-3, R2-5 accepted as is
E36 [P3] mod+shift+enter (session.sendOther) is ONE-SHOT — sends this message the other way, never saves the default (split-button choice stays the persistent selector, M2 970d8c5); avoids the steer/follow-up alternation
E37 [P3] raw HTML in model text renders as literal text (html nodes → text), not dropped — "Array<string>" outside backticks must not lose "<string>"; never rendered as HTML
E38 [P3] palette "Stop the run"/"Send the other way" target the session focused before the palette opened (else the active pane); sendOther when-rule gains !inlineEditFocus && !overlayOpen && !dialogOpen
E39 [P1] m11 i18n disjointness test folds into P1 (P7 missed it); no invented alias mapping — stop and report
E40 [P5] #44's "stale may-have-been-sent after a remount" folds into P5 (same stores/composer area)
E41 [P6] budget = min(ceil(194.7 × 1.10)=215, 200) = 200, unchanged → no commit; owner informed in the merge question (5.3 KB headroom)
