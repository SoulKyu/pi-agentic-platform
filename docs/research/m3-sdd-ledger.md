# M3 SDD ledger (archived 2026-10-12)

Controller ledger of the M3 subagent-driven run (including the post-merge tasks P1–P7), copied verbatim from the git-ignored SDD workspace before its worktree was removed. Rulings: [m3-rulings.md](m3-rulings.md). Final review findings are summarised in the ledger lines `M3 final: ...`.

# SDD ledger — plan: docs/plans/2026-10-11-m3-design-system.md
Spec: DESIGN.md (binding for M3) + docs/specs/2026-10-10-C-architecture.md. Worktree: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m3 (branch feat/m3-design). Start base: 4ecc524.
Models (owner-approved X2, 2026-10-11): implementers Haiku for T4, T7, T11, Sonnet for the rest; reviewers Sonnet except Opus for T12, T14, T15; scoped re-reviews of small fix diffs Sonnet; final whole-branch review Opus; P1–P7 Sonnet/Sonnet (after M2 merges). Fix rounds 4–5: Opus implementer pre-approved by the owner for M3 (T1).
Pipelining: one implementer in this worktree at a time; M2 runs in feat-m2 in parallel. Merge order: M2 first, then M3 rebases, re-stamps its migrations, runs P7 → P3 → P2 → P1 → P4 → P5 → P6.
Env: node 24.14.x; pnpm via .superpowers/bin shim; deps installed (frozen lockfile); no browser (e2e Tasks 29–31 removed, owner C1).
Preflight: Opus red-team (.superpowers/redteam-m3.md, 1 Critical / 22 Important / 18 Minor / 12 overlap) applied by an Opus plan fix (4ecc524); conflict scan table in the plan; 135 rulings M3R1–M3R135 in rulings.md and inline per task. Owner decisions: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/owner-decisions-2026-10-11.md. Cross-plan: .superpowers/m2-m3-cross-plan-agreements.md.
Ruling: code highlighting uses the agent colour only (keywords violet, comments muted, rest plain) — plan-fix decision under DESIGN "hues are never decorative", accepted — cost if wrong: a later restyle of Fence (low).
Ruling: the 44-px coarse-pointer rule is checked headless as CSS classes over the gallery, PNG icons move to M12 with the manifest — consequence of C1 — cost if wrong: a real-size regression only caught by hand (low).
Note: task-brief for Task 10 also matches "Task 10b" (regex `Task 10[^0-9]`); cut the Task 10 brief at the "### Task 10b" heading.
Task order: 1a, 1b, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10b, 11, 12, 13, 14, 15, 16a, 16b, 17a, 17b, 18, 19a, 19b, 20, 21, 22, 23, 24, 25, 26, 27, 28, 32.
Task 1a: dispatched implementer (sonnet), BASE 4ecc524, agent a8caeb282fe375c5d; brief task-1a-brief.md; report task-1a-report.md
Task 1a: implementer DONE_WITH_CONCERNS (b44d797) — concerns: tokens.css header comment reworded (test matched comment); @theme inline note pending in docs/agents/web.md → carry to Task 32 docs; Tailwind compile exercised in 1b
Task 1a: minor (deferred): ADR 0012 quotes ratios the test does not pin (3.43, 3.55/3.56, 4.48, 4.6, 2.26)
Task 1a: minor (deferred): alias test misses human-tint, human-line, attention-tint, attention-line (M2 uses them) → carried to Task 1b's token-class compile test
Task 1a: minor (deferred): --shadow-overlay values and font stacks not compared with DESIGN §3.4; no-JS fallback specificity vs data-grid="off" (theoretical); utilities.css comments cite Orca/pw paths without context
Task 1a: ⚠️ resolved by controller: Tailwind compile of @theme inline / @utility focus-ring → pinned by Task 1b; web.md @theme inline note → Task 32
Task 1a: complete (commits 4ecc524..b44d797, review clean)
Task 1b: dispatched implementer (sonnet), BASE b44d797, agent a3d07d16db66ef801; carried: alias compile test incl. human-tint/human-line/attention-tint/attention-line
Task 1b: implementer DONE (096fa8a) — M3R7 @utility fallback not needed (Tailwind 4.3.3 resolves named spacing); no mutation check on the no-nesting test
Task 1b: minor (deferred): @theme/@utility compile test asserts absence only — add positive asserts (var(--surface-2), outline: 2px solid); alias list duplicated, aliases checked for existence not value
Task 1b: minor (deferred): nesting regex misses `}&…` (brief-mandated) and has no mutation check; Button.test.tsx:236 title overclaims; vite-config.test.ts stale /src/fonts path
Task 1b: complete (commits b44d797..096fa8a, review clean)
Task 2: dispatched implementer (sonnet), BASE 096fa8a, agent a50cd65a699274d2f
Task 2: implementer DONE_WITH_CONCERNS (e8d43f2) — fixed compiler bailouts in Button.tsx/ApprovalCard.tsx; CLASS_CONSTANT regex prefix made optional; classCandidates double-count fixed
Ruling: the compiler gate also excludes M2-owned features/sessions via M2_OWNED_UNTIL_P7 (SessionListScreen try/finally bailout) — same rule as the class/literal scans (cross-plan agreement 8, P7 removes it) — cost if wrong: an M2 compiler bailout surfaces only at P7 (low)
Task 2: minor (deferred): compiler-gate.test.ts duplicates the M2_OWNED_UNTIL_P7 regex instead of importing it (P7 must remove both); no committed failing fixture for the compiler gate; no-native-title misses member-expression elements / spreads
Task 2: complete (commits 096fa8a..e8d43f2, review clean)
Task 3: dispatched implementer (sonnet), BASE e8d43f2, agent ab06952554bae3ae0
Task 3: implementer DONE_WITH_CONCERNS (65249c8) — i18n.test.ts renamed i18n.test.tsx (JSX); no RED run (4 mutation checks instead); M2 block absent here (merges keep-both)
Merge note: apps/web/src/i18n/i18n.test.ts is now i18n.test.tsx on M3 — M2 edits to i18n.test.ts (if any) re-applied on the .tsx at rebase
Controller: implementer-common (M2 + M3) now makes RED-before-implementation explicit (two tasks skipped it: M2 1b, M3 3)
Task 3: review dispatched (sonnet), agent a5164a03123333d1b
Task 3: review → Needs fixes (2 Important open + evidence gap): no fixture for literal-gate exclusion/failure/allowlist; i18n.test rename merge risk; RED missing
Ruling: literal gate keeps skipping apps/web/src/gallery/ (dev-only, not shipped per ADR 0011; plan-mandated) with a one-line comment saying why — cost if wrong: untranslated gallery labels (none for users)
Ruling: i18n.test.ts → .tsx rename stands (JSX needs .tsx); M2 does not edit i18n.test.ts (agreement 4: no fr==en keys) — merge note already recorded — cost if wrong: one modify/delete conflict at rebase (low)
Task 3: minor (deferred): literalsIn misses aria-label={"x"}, ternaries, template literals, fragments, .ts strings (state limits in a comment); reportClientIssue clock-backwards suppression; serverText surrogate split / no bidi strip; stale allowlist entries undetected; 9 999 ms boundary untested; locale restore only on pass
Task 3: fix round 1/5 dispatched (resumed implementer ab06952554bae3ae0), FIX_BASE 65249c8
Task 3: fix round 1/5 (3 addressed, 0 open — literal-gate fixtures + RED, 6 mutation checks, pristine i18n tests; commits 65249c8..baa9311)
Task 3: complete (commits e8d43f2..baa9311, review clean after 1 fix round)
Task 4: dispatched implementer (haiku), BASE baa9311, agent a1d35292b759d1a89
Task 4: implementer DONE_WITH_CONCERNS (609b06b) — defaults moved into bodies (compiler gate); happy-dom devDep on @pap/ui (knip); click/press dropped from testing/dom.ts; extra usePendingAction test not RED-first; lucide-react 1.53.0 (1.55.0 inside minimumReleaseAge); test:int/budget not run
Task 4: review → Needs fixes (2 Important, plan-mandated): I1 formatDiffCounts/ProgressBar print NaN or out-of-range for NaN/negative/Infinity max (M3R19 not met); I2 usePendingFeedback stores clock.now() not the mark time → phase can stick if a timer fires early. Bundle budget test passes.
Ruling: fix both despite the prescribed code — M3R19 (never NaN / never out of range) is binding over the brief's code; the early-timer clamp `Math.max(clock.now(), since + mark)` keeps the brief's behaviour on exact clocks — cost if wrong: none
Task 4: minor (deferred): ProgressBar value=Infinity → empty bar (clamp to max); Spinner/Icon untested (label vs aria-hidden, strokeWidth, size); usePendingFeedback local 1000/3000 ms marks untested; inline clock object re-arms timers each render
Task 4: fix round 1/5 dispatched (resumed haiku implementer a1d35292b759d1a89), FIX_BASE 609b06b
Task 4: fix round 1/5 (2 addressed, 0 open — NaN/out-of-range sanitised with tests; early-timer clamp; commits 609b06b..c15ce9c)
Task 4: complete (commits baa9311..c15ce9c, review clean after 1 fix round)
Task 5: dispatched implementer (sonnet), BASE c15ce9c, agent a438cece69b5a4439
Task 5: implementer DONE (23a0779) — radix-ui 1.7.0; defaults in bodies (compiler gate); SessionScreen.test.tsx two assertions changed (M3R22) — re-apply at M2 rebase
Task 5: minor (deferred): IconButton throws outside TooltipProvider → CARRY: the first task that mounts IconButton/Tooltip in a web or ui test (Task 8/9 or 19a) adds a provider-wrapping mount helper (packages/ui/src/testing/dom.ts / apps/web/src/testing) and a one-line comment on IconButton; also P3 (M2 screens) must wrap
Task 5: minor (deferred): aria-busy / disabled / aria-pressed pass-through untested; loose danger regex; Tooltip delays untested; disabled IconButton has no tooltip
Task 5: complete (commits c15ce9c..23a0779, review clean)
Task 6: dispatched implementer (sonnet), BASE 23a0779, agent a018239ab90587c8a
Task 6: implementer DONE (6e751a4) — click helper added to packages/ui/src/testing/dom.ts (outside list); Select popup untested (no browser)
Task 6: minor (deferred, a11y — triage at final review): Segmented items lack pointer-coarse:min-w-11 (44 px); Switch label is a span (clicking text doesn't toggle); Segmented container uses hairline border not control-border (plan-mandated)
Task 6: minor (deferred): "never none" test weak (add toHaveBeenCalledTimes + mutation); Switch "square" title unasserted; hint/disabled untested on Switch/Select; Select popup width not tied to trigger
Task 6: complete (commits 23a0779..6e751a4, review clean)
Task 7: dispatched implementer (haiku), BASE 6e751a4, agent a853b47644a128ed2
Task 7: implementer NEEDS_CONTEXT (press helper missing in packages/ui testing/dom.ts) → answered: add press mirroring apps/web/src/testing/dom.ts; resumed
Task 7: implementer DONE (5a3a23e) — defaults in bodies (compiler gate); press helper added to packages/ui testing/dom.ts; Collapsible + IconButton badge no runtime tests (brief specifies none); EmptyState prop type not exported
Task 7: review → Needs fixes (5 Important, 2 plan-mandated): OpenTab focus ring on a non-focusable div + outline-none on the button (DESIGN §7.4); Meter NaN/out-of-range for bad max (M3R19); Badge prints NaN/negative; OpenTab select button not 44 px on coarse; untested guards (count>0, max>0, Collapsible wiring, IconButton badge)
Ruling: DESIGN §7.4 (focus ring never removed), M3R19 (never NaN / out of range), the 44-px coarse rule and the checklist (a test per guard) bind over the brief's prescribed OpenTab/Meter/Badge code — cost if wrong: none
Task 7: minor (deferred): Avatar role=img hides badge/presence from AT; OpenTab wrapper lacks role=presentation, unused `group`, no way to read truncated title; Badge 99/100 boundary untested; index.ts export order; EmptyState/Chip prop types not exported
Task 7: fix round 1/5 dispatched (resumed haiku a853b47644a128ed2), FIX_BASE 5a3a23e
Task 7: fix round 1/5 (5 addressed, 0 open — OpenTab focus ring + 44 px on tab button, Meter/Badge sanitised, guards tested; commits 5a3a23e..fb6fad7)
Task 7: minor (deferred): OpenTab wrapper h-bar vs 44 px buttons may overflow on coarse (no render check); Meter width guard unasserted; Collapsible test title misleading; Badge Infinity → 0 not 99+; 0.5 passes count>0 but renders 0
Task 7: complete (commits 6e751a4..fb6fad7, review clean after 1 fix round)
Task 8: dispatched implementer (sonnet), BASE fb6fad7, agent ace8a76d5784edb10; carried: TooltipProvider mount helper
Task 8: implementer DONE_WITH_CONCERNS (caa142c) — prescribed Dialog focused the IconButton close first (tooltip swallowed Escape) → panel takes focus unless initialFocus; settle() not needed; ui.close key unused yet; toast viewport lift left to Task 23; mountWithTooltips helper added
Task 8: minor (deferred): Toast viewport keeps Radix's English region label (add ui.notifications via useT); focus return uses activeElement (Safari/iOS → body; plan-mandated); programmatically focused panel has outline-none; toasts unclickable while a Radix modal sets pointer-events:none (check when a toast is raised from a dialog action); menu remount across 768 px; ui.close key unused; no test that Escape closes only the top overlay
Task 8: complete (commits fb6fad7..caa142c, review clean)
Task 9: dispatched implementer (sonnet), BASE caa142c, agent a2e774b14b3d7016f
Task 9: implementer DONE_WITH_CONCERNS (03bc25f) — defaults in bodies; RUN_TONES → CHIP_BY_STATUS (class-coverage reads *TONES); title omitted from MessageActionProps
Flake watch: Dialog.test "returns focus" (Task 8) failed once in a partial run, passed in the full run — order-dependent? → watch; fix if it recurs
Task 9: minor (deferred): branch position not announced (aria-live; plan-mandated); no hostile-content Fence test; RunStatus settled/limited + dot rule untested; MessageActions no own test; grouped Message + AuthorGroup repeat the author name to screen readers
Task 9: complete (commits caa142c..03bc25f, review clean)
Task 10: dispatched implementer (sonnet), BASE 03bc25f, agent a20d23bf214c161fe (brief cut before 10b)
Task 10: implementer DONE (636531e) — once-guard via === null (compiler gate); card classes moved to new names (p-s3, border-border, bg-attn-tint)
Task 10: minor (deferred): ApprovalCard header textContent "Approval·exec" (separator is aria-hidden span) — P3 must not match "Approval · exec" literally; ToolCard tool name shrink-0 without clip (long/hostile extension name overflows); context not in aria-describedby; Reasoning manual-toggle persistence and ToolCard error/header-only untested
Merge note: M1 packages/ui ApprovalCard.test.tsx class assertion changed by M3 (bg-attention-tint → bg-attn-tint) — take M3's version at rebase
Task 10: complete (commits 03bc25f..636531e, review clean)
Task 10b: dispatched implementer (sonnet), BASE 636531e, agent af11cbf7a71c3fada
Task 10b: implementer DONE (10a3e21) — react-markdown 10.1.0, remark-gfm 4.0.1, shiki 4.5.0 (JS engine, no .wasm); initial bundle 157.73 KB gz (lazy chunks: renderer 62.5, highlighter 52.9); dynamic import moved to module level (compiler gate); onerror assertion added (skipHtml mutation otherwise undetected); Object.hasOwn language lookup
Flake: Dialog.test "returns focus" failed a 2nd time in a full unit run (Task 8 code) → Ruling: fix now (resume Task 8 implementer) before Task 11 — a flaky test hides regressions — cost if wrong: none
Task 10b: review dispatched (sonnet), agent ac9accca96c7dc903 | Flake fix dispatched to Task 8 implementer ace8a76d5784edb10 (FIX_BASE 10a3e21)
Task 10b: review → Approved with 1 Important (enters loop): link-hardening and prototype-key tests missing (JaVaScRiPt:, vbscript:, //evil, leading control chars, entity-encoded at render level; highlightCode("constructor"/"__proto__"/"toString") → null). Fix round 1 queued until the flake fix (same worktree) finishes.
Task 10b: minor (deferred): comment italic unasserted; docs/agents note on untrusted-markdown policy (→ Task 32 docs; needed by M2 adoption P3); synchronous highlighting on streaming updates (no debounce/aggregate budget) → follow-up for the streaming path; plain fallback lacks text-chat; failed boundary never resets
Flake fix: DONE (78be9b1) — cause: Radix FocusScope returns focus in setTimeout(0); test asserted too early; settle() helper awaits one macrotask; shuffled 25× Dialog + 8× packages/ui green (was 3/5 and 4/6 failing). Re-review folded into Task 10b's fix re-review.
Task 10b: fix round 1/5 dispatched (resumed sonnet af11cbf7a71c3fada), FIX_BASE 10a3e21 (range includes 78be9b1)
Task 10b: fix round 1/5 (1 addressed + flake B1 addressed — safeHref table, render-level entity cases, prototype-key guard pinned, comment italics implemented; commits 10a3e21..5aa2889)
Task 10b: complete (commits 636531e..5aa2889, review clean after 1 fix round; includes flake fix 78be9b1)
Task 11: dispatched implementer (haiku), BASE 5aa2889, agent a529fd51304143ed2
Task 11: implementer DONE (dfc593f) — Mark size default in body (compiler gate); day colours unverified visually
Task 11: minor (deferred): dropped doc comments on Mark/Wordmark; favicon content check weak (startsWith "<svg")
Task 11: complete (commits 5aa2889..dfc593f, review clean)
Task 12: dispatched implementer (sonnet), BASE dfc593f, agent a3c4a58d9b8565dc0 (reviewer will be Opus)
Task 12: implementer DONE (71cf961) — appearance test const typed; extra cross-owner test; no docs/agents/settings.md (→ Task 32); migration stamp 202610111000 to re-stamp at rebase (agreement 1)
Task 12: CARRY to Tasks 13 and 15 dispatch: a damaged settings row reads as { value: null, revision: n > 0 } — the client must send that revision as baseRevision (never 0), else every write conflicts forever
Task 12: minor (deferred): no crossing test for customThemes.max(16) and per-string caps; byte-cap boundary (exact cap vs +1) unpinned; int test `as never` casts + toMatchObject; docs/agents/daemon.md module list + settings note (→ Task 32); RED not shown for the int test / methods.test change
Task 12: complete (commits dfc593f..71cf961, Opus review clean)
Task 13: dispatched implementer (sonnet), BASE 71cf961, agent a461d1577d37f0fa5; carried: damaged-row revision rule
Task 13: implementer DONE (02f03f2) — duplicate() not here (M3-RT-32 test → Task 26, M3R116); DEVICE_KEY/ACCOUNT_CACHE_KEY pinned by a small test (knip); created docs/agents/web.md (M3R53 derivation ratios)
Task 13: CARRY to Task 26 dispatch: M3-RT-32 — duplicating a preset takes roles from *-fill; test deriveTheme(duplicate(day))["you-fill"] === "#fb923c"
Task 13: CARRY to Task 32: docs/agents/web.md already exists (created in Task 13) → Modify, not Create; drop the "only exempt files" wording
Task 13: CARRY to Task 25: Reset keeps the custom theme library (owner R3-2) — no reset path exists yet
Task 13: minor (deferred): 64-entry read cap uncrossed; preset id literals duplicated (use PRESET_THEME_IDS); mergeAccount `in` → Object.hasOwn; parseDevice accepts arrays
Task 13: complete (commits 71cf961..02f03f2, review clean)
Task 14: dispatched implementer (sonnet), BASE 02f03f2, agent a4a49f841ebe5790f (reviewer will be Opus)
Task 14: implementer DONE (304c84b) — boot script appearance-boot-<hash>.js first in head, no inline script; bundle 160.04 KB gz; prescribed tests fixed (?raw import, regex vs prettier wrap, cast, syncThemeColor test); 8-digit hex accepted (brief regex); dev middleware untested
Task 14: CARRY to Task 15 (wires the applier/boot cache): pin the boot script's attribute-name list against APPEARANCE_ATTRS (like the var-names pin); a round-trip test toBootCache(account with a custom theme) → storage → run() sets every cache var (incl. #rrggbbaa); eslint block for apps/web/src/**/*.js gets languageOptions { ecmaVersion: 2019, sourceType: "script" } (Safari 16.4 floor for the raw asset); assert "two frames later" (theme-swap still present after the first frame) and the cancel path; assert reportClientIssue("boot_cache_refused")
Task 14: minor (deferred): varValue bounds wider than the model (0–99.99px, alpha on opaque tokens; self-inflicted only); no raw.length cap; theme-color flash on iOS until syncThemeColor (trade-off); module-global pending; dev middleware reads source once; knip vite/*.ts entry; web.md boot-script rules (→ Task 32)
Task 14: complete (commits 02f03f2..304c84b, Opus review clean)
Task 15: dispatched implementer (sonnet), BASE 304c84b, agent a7497f17e0bfbfa1e (reviewer will be Opus); carried Task 14 pins
Task 15: implementer DONE_WITH_CONCERNS (e08f5cb) — no storage listener (M3R63 says none in M3); held-guard mutation shows as an OOM resend loop, not a named assertion; prescribed device-settings test fixed (spyOn localStorage.setItem); bundle not measured (controller now in main.tsx); test:int not run
Task 15: review dispatched (OPUS), agent ac64e86f8eb58af96 (with build-output budget run)
Task 15: Opus review → Needs fixes (1 Important): the `held` guard (no endless resend) is only caught by an OOM, not a named bounded-count test (fake servers throw when their script runs out). Bundle ≤ 180 KB (test passes; no figure). Engine bounded on all reachable paths (a–e) per reviewer.
Task 15: minor (deferred): duplicated Timers/WINDOW_TIMERS vs runtime; resetAll / boot attribute-list mutation checks not run
Task 15: fix round 1/5 dispatched (resumed sonnet a7497f17e0bfbfa1e), FIX_BASE e08f5cb
Task 15: fix round 1/5 (7 addressed — named bounded-count tests for held, reload before flush, reports asserted, real ES2019 lint via espree 11.2.0 (same as eslint's), bundle 163.4 KB gz, blocked storage guarded; commits e08f5cb..f31240c; Opus re-review clean)
Controller: the re-reviewer claimed the review package was lossy (rtk); verified IDENTICAL to `rtk proxy git diff -U10` — its own git calls were rewritten. Added a shell note to both reviewer-common files.
Task 15: CARRY to Task 19b (wires syncAccountAppearance on socket open): narrow race — a conflict on the in-flight save during sync re-sets phase=loaded and lets a change made in that window be sent before sync's reload; fix with a `syncing` flag checked by pump, cleared just before load(call), with a test
Task 15: minor (deferred): stale doc comment controller.test.ts:36; held=true in pump .catch untested (defence in depth)
Task 15: complete (commits 304c84b..f31240c, Opus review clean after 1 fix round)
Task 16a: dispatched implementer (sonnet), BASE f31240c, agent aac8ee9186d0342b7
Task 16a: implementer DONE (8c143e1) — fixed prescribed parseChord (non-string input; prototype names like constructor+k) with tests; reserved-chords flag left to 16b
Task 16a: review → Needs fixes (3 Important, plan-mandated): recorder emits chords parseChord refuses (mod+meta / mod+ctrl, bare "+"); physical key chosen by code class (AZERTY m on Semicolon → mod+;, NumLock-off numpad End → mod+1); event.key undefined throws (autofill keydown)
Ruling: physical key only when the layout key is unusable or is itself a digit/punctuation character; a usable letter or named layout key is kept (R3-7 intent: layout-independent digits/punctuation, letters by meaning) — cost if wrong: letters on exotic layouts match by layout (low)
Task 16a: fix round 1/5 dispatched (resumed sonnet aac8ee9186d0342b7), FIX_BASE 8c143e1; Task 16a: minor (deferred): SHIFTED_SYMBOL treats any single non-ASCII char as shifted; ß label → SS; reserved-chords owner (16b) to confirm
Power cut 16:3x: Task 16a fix round 1 resumed (aac8ee9186d0342b7) with its uncommitted work intact
Task 16a: fix round 1/5 (3 Important + minors addressed — parseable recorder output with round-trip test, physical key per ruling, keyless events tolerated, 64-char cap, UI Events aria names; commits 8c143e1..577cf02)
Ruling: Cmd++ on the main-row + records as mod+shift+= (punctuation by physical key, owner R3-7); the UI label shows ⌘⇧= — accepted — cost if wrong: a dedicated + key on other layouts (e.g. German BracketRight) doesn't match a binding recorded on the Equal key (low)
Task 16a: minor (deferred): ariaKeyShortcuts emits Control++ (ARIA may want "Plus"); a layout whose Equal key produces a letter won't match a recorded "="
Task 16a: complete (commits f31240c..577cf02, review clean after 1 fix round)
Task 16b: dispatched implementer (sonnet), BASE 577cf02, agent af87e591078c65b64
Task 16b: implementer DONE (ba68764) — conflictsOf groups by chord; parseWhen 256 cap + non-string refusal; prototype names unknown → false; unused eslint-disable removed; extra hardening tests
Task 16b: review → Needs fixes (1 Important, test-only): precedence tests pass under a wrong grammar
Task 16b: minor (deferred): Alt+↑/↓ and Ctrl+Alt+1..9 fire inside text fields (pi-web parity; macOS paragraph nav / AltGr on Windows) → UX note; conflicts compare clause text
Task 16b: fix round 1/5 dispatched (resumed sonnet af87e591078c65b64), FIX_BASE ba68764
Task 16b: fix round 1/5 (1 Important + 2 minors addressed — discriminating precedence cases, default count pinned, prototype lookup + de-dup tests; commits ba68764..4147f2c)
Task 16b: complete (commits 577cf02..4147f2c, review clean after 1 fix round)
Task 17a: dispatched implementer (sonnet), BASE 4147f2c, agent a2ac166e31ea029d9
Task 17a: implementer DONE (aed183d) — throwing handler caught + command_failed report, key passes through; CommandHandler boolean|void kept with an eslint-disable-next-line (reasoned); idempotent unregister; extra tests
Task 17a: review dispatched (sonnet), agent aacb46344d8766962
Task 17a: CARRY to every later task rendering a listbox/menu (Select popups, palette Task 22, shortcuts editor Task 27): overlayOpen counts ANY [role=listbox]/[role=menu] in the document — never keep a non-overlay listbox/menu permanently in the DOM (or narrow the check), else Escape → session.stop becomes unreachable
Task 17a: minor (deferred): CommandHandler could be `() => boolean | undefined` (drop the directive); throw test doesn't show a later candidate is still tried; registry changed() not isolated per listener; command_failed log lacks the command id
Task 17a: complete (commits 4147f2c..aed183d, review clean)
Task 17b: dispatched implementer (sonnet), BASE aed183d, agent ab773db49d61c8a1f; carried: damaged-row revision, M3-RT-29 cache parse, listbox rule
Task 17b: implementer DONE_WITH_CONCERNS (2ff9000) — ShortcutsHelp default export only (knip duplicate exports; Task 21 lazy-loads it); commands.group.* added to IDENTICAL_IN_FR; help test wraps TooltipProvider by hand
Task 17b: CARRY to Task 19b (shell key effects): wire useKeybindingsStore.rules into the dispatcher's rules() getter and startKeybindings on socket open, if not already in its brief
Task 17b: minor (deferred): startup/replaceFromServer resolution issues not reported; non-array cache/server value silently [] (no keybindings_invalid); help shows only the last chord per command
Task 17b: complete (commits aed183d..2ff9000, review clean)
Task 18: dispatched implementer (sonnet), BASE 2ff9000, agent a8faf197f6673960c
Task 18: implementer DONE (dcf9d5d) — workspace_invalid report code; 64 000-char payload cap; split showing the same item as its tab dropped
Task 18: review → Needs fixes (1 Important): untrusted ids — a persisted lone surrogate makes pathOfItem throw (encodeURIComponent URIError); `.`/`..` ids don't round-trip (/s/.. normalised to /); id rule duplicated in item-path.ts and persist.ts
Task 18: minor (deferred): openItem/cycleTab no-op returns a new object (brief-prescribed); two browser tabs share pap.workspace.v1 (last writer wins; doc note); MIN/MAX_RATIO, clampRatio, MAX_ID exported — Task 19a index.ts must not re-export them
Task 18: fix round 1/5 dispatched (resumed sonnet a8faf197f6673960c), FIX_BASE dcf9d5d
Task 18: fix round 1/5 (2 addressed — shared isValidId, total pathOfItem, dots/%2e/lone surrogate refused, proto + long %XX tests; commits dcf9d5d..dfd4a9b)
Task 18: CARRY to Task 19a/19b (URL sync caller): an invalid session id maps to "/" — treat it as home and never re-push when the path already matches (no navigation loop)
Task 18: complete (commits 2ff9000..dfd4a9b, review clean after 1 fix round)
Task 19a: dispatched implementer (sonnet), BASE dfd4a9b, agent aeabb6c930361724f
Task 19a: implementer DONE (a56a3cc) — bundle 163.1 KB gz; PaneBoundary.tsx added (lazy-pane loading, stale-chunk "pap was updated" + Reload, generic error); SETTINGS_SECTIONS not exported yet (knip); PaneHost passes an empty sessions list
Task 19a: CARRY to Task 19b: PaneHost needs the real sessions list (sessions cache) for session pane labels
Task 19a: review → Needs fixes (2 Important): non-stale pane/route render errors not reported (no ClientIssue code); stale-chunk report emission untested
Task 19a: minor (deferred): PaneHost may show the previous tab for one commit after a URL change (store activeTab vs URL); NotFound void navigateTo without .catch
Task 19a: fix round 1/5 dispatched (resumed sonnet aeabb6c930361724f), FIX_BASE a56a3cc
Task 19a: fix round 1/5 (2 Important + minors addressed — render_failed reported once per failure, report assertions exact, history/stale-chunk/NotFound fixes; commits a56a3cc..6bcd414)
Task 19a: complete (commits dfd4a9b..6bcd414, review clean after 1 fix round)
Task 19b: dispatched implementer (sonnet), BASE 6bcd414, agent a170860fd0afad9cf; carried: sessions list for PaneHost, dispatcher↔keybindings wiring + sync on socket open, Task 15 syncing-flag race, invalid-id home/no re-push
Task 19b: implementer DONE_WITH_CONCERNS (c955aa3) — initial bundle 163 → 197.9 KB gz (+35 KB, likely Menu/Tooltip/icons), budgets.json raised to provisional 208 (> owner's 200 ceiling); carried item 4 needed no change (no tab→URL push); RED for sessions-cache/AppShell captured after the fact; no generation counter (single in-flight promise)
Ruling: budgets.json provisional value may not exceed the owner's 200 KB ceiling (R3-5); with 197.9 KB measured and Tasks 20–23 still adding eager code, the initial chunk must come back down now — identify the +35 KB and lazy-load what first paint doesn't need (menus' content, tooltips' portal, rarely used icons…), target ≤ ~185 KB, budget set to measured × 1.05 capped at 200 — cost if wrong: one fix round (low); otherwise the owner is asked before the next eager task
Task 19b: review → Needs fixes: bundle +27.7 KiB gz JS (Menu stack incl. Dialog via Menu's phone sheet ≈13.5, Tooltip/Popper/floating-ui via IconButton ≈10) not needed at first paint; budget 208 > ceiling. Important 2: session titles stale until reconnect (refresh only on open)
Ruling: overlays leave the eager barrel — `Menu` and `Dialog` (and their Radix stacks) move to a lazy subpath entry `@pap/ui/overlays`; IconButton's Tooltip content is loaded on first pointerenter/focus (TooltipProvider stays eager); budgets.json initialBundleGzipKb = measured × 1.05, never above 185 here (200 hard ceiling); every later M3 task that needs Dialog/Menu/Sheet/Drawer (21 tree drawer, 22 palette + ShortcutsHelp, 24–27 settings) imports them from `@pap/ui/overlays` inside a lazy boundary — CARRY to Tasks 20–28 — why: owner R3-5 bundle ≤ 200 with headroom for Tasks 20–23 — cost if wrong: first open of a menu/tooltip waits for a small chunk (~tens of ms on LAN)
Ruling: sessions cache also refreshes when the active item is a session id missing from the list (bounded: at most one refresh per missing id per open) — cost if wrong: one extra sessions.list (none)
Task 19b: fix round 1/5 dispatched (resumed sonnet a170860fd0afad9cf), FIX_BASE c955aa3
Task 19b: fix round 1/5 (5 addressed; bundle 197.9 → 174.0 KB gz, budget 183; commits c955aa3..844506b) — re-review: one test hangs instead of failing by name → fix round 2/5 dispatched (resumed a170860fd0afad9cf), FIX_BASE 844506b; Ruling: TooltipProvider pass-through (skip-delay lost) accepted — cost: every tooltip waits 400 ms (cosmetic)
Task 19b: fix round 2/5 (1 addressed — exact call count, fails by name without the guard; commit e79f4a9)
Task 19b: CARRY to Task 22: ShortcutsHelp (imports @pap/ui/overlays) must be loaded via React.lazy/dynamic import, never statically, or Dialog returns to the entry chunk; same for the palette
Task 19b: minor (deferred): a 33rd distinct missing id per open never refreshes; pointer resting on a control when the popup mounts needs a move to show the tooltip; tooltip chunk failure unreported (label stays)
Task 19b: complete (commits 6bcd414..e79f4a9, review clean after 2 fix rounds; bundle 174.0 KB gz, budget 183)
Task 20: dispatched implementer (sonnet), BASE e79f4a9, agent a5081cc98612c5f9a
Task 20: implementer DONE (086adaa) — bundle 173.5 KB gz; claims useCommand doesn't exist (it does: features/commands/use-command.ts) → used registerCommand directly; split target = previous else next tab, split disabled when none; AppShell.test aria-label → aria-labelledby; equivalent mutant on TabBar close guard
Task 20: review → Needs fixes (2 Important): focus lost to <body> after closing the active tab; useCommand bypassed on a false "does not exist" claim (it exists, not exported from features/commands/index.ts)
Ruling: split falls back to home when there is no other tab and the active item isn't home (brief intent, no self-split) — cost if wrong: none
Task 20: minor (deferred): disabled split IconButton's tooltip unreachable; tablist doesn't scroll the active tab into view; redundant aria-label on "Show in this pane"; pointercancel commits instead of reverting
Task 20: fix round 1/5 dispatched (resumed sonnet a5081cc98612c5f9a), FIX_BASE 086adaa
Task 20: fix round 1/5 (4 addressed — focus after close, useCommand exported + used, lone split with home, clamped aria-valuenow; commits 086adaa..b634d1d)
Task 20: CARRY to Task 21: test hygiene — mounts are unmounted inline at test end (a failed assertion leaks registrations and cascades); add a shared auto-unmount (track mounts in apps/web/src/testing/dom.ts + packages/ui testing dom, unmount in a global afterEach) and use it
Task 20: minor (deferred): inactive-tab close test weak (assert focus stayed); no "home alone → disabled" test; module-level focusAfterClose shared across TabBar instances
Task 20: complete (commits e79f4a9..b634d1d, review clean after 1 fix round)
Task 21: dispatched implementer (sonnet), BASE b634d1d, agent a82a46fcd1dd737bb; carried: auto-unmount test hygiene
Task 21: implementer DONE_WITH_CONCERNS (commit 55da107; unit 1830, int 198 pass) — bundle 184.06 KB gz > 183, budget raised provisionally to 194 (HEAD before = 178.28, cause: entry split into 7 shared chunks by the 3 new dynamic imports); tab commands moved TabBar → tab-actions.ts; AppShell test uses palette.toggle
Task 21: task review dispatched (sonnet), diff b634d1d..55da107
Task 21: review NEEDS FIXES — 1 Important (Escape-in-drawer test vacuous: focus in Dialog so sessionFocus false; mutation survives) + 6 minor
Task 21: Ruling: bundle provisional budget 194 accepted, vite.config unchanged (reviewer tried 6 Rolldown codeSplitting variants: 184.16–239.26 KB, none safe); real delta = +3.1 KB code + 2.7 KB fragmentation (9 initial JS files). CARRY to Task 32: re-measure, consider pinning initial JS file count in the int test
Task 21: fix round 1/5 dispatched (resume implementer): Escape test (tree + inbox, focus in session pane), getDerivedStateFromError pin, unmountAll tries all + rethrows, AppShell test own command, single sign-out handler, report corrections; FIX_BASE 55da107
Task 21: minor (deferred to final): blank drawer until chunk loads; retry re-rejects where browsers cache failed module fetch (bounded)
Task 21: fix round 1 implementer DONE (commit a55ad5a; unit 1835, build-output int pass); scoped re-review dispatched (sonnet), diff 55da107..a55ad5a
Task 21: fix round 1/5 (Important + 5 minors addressed — Escape test reaches the real dispatcher for tree + inbox, mutations fail; unmountAll aggregate; own test command; shared signOut; commit a55ad5a)
Task 21: minor (deferred to final): AppShell shortcuts test clones product chords (use a fixed test chord like mod+j)
Task 21: complete (commits 55da107..a55ad5a, review clean after 1 fix round)
Task 22: dispatched implementer (sonnet), BASE a55ad5a, agent acf39a59813b2ecea; carried: palette lazy via LazyBoundary, bundle measure + initial JS count, >200 → BLOCKED, AppShell test fixed chord, cmdk respects minimumReleaseAge
Task 22: implementer DONE (commit 7eae8fd; unit 1858, int 198) — cmdk 1.1.1 (minimumReleaseAge respected), initial 185.11 KB gz in 10 JS + 1 CSS (budget 194 unchanged), palette lazy via LazyPanel; task review dispatched (sonnet)
Task 22: review NEEDS FIXES — 2 Important (ranking: title bonus, '>' filter, position tie-break untested; Escape test lacks session.stop probe) + minors; bundle verified 184.8 KiB gz, cmdk lazy-only, pinned 1.1.1
Task 22: Ruling: palette.toggle excluded from its own list (selecting it would close as it opens); fr plural treats 0 as singular
Task 22: fix round 1/5 dispatched (resume implementer): ranking tests ×3, Escape with probe, fr 0 singular, digit-chord test with real dispatcher, multi-group cap, scoped console silencing; FIX_BASE 7eae8fd
Task 22: minor (deferred to final): unused platform prop (prescribed); initial live-region count not announced; no phone-sheet test (Dialog T8); nested scroll on short viewports
Task 22: fix round 1 implementer DONE (commit 172cbc5; unit 1865, int 198, bundle 185.12); Escape guards overlayOpen/dialogOpen/paletteOpen redundant for the palette (defence in depth, accepted); scoped re-review dispatched
Task 22: fix round 1/5 (2 Important + 4 minor addressed — ranking pins, Escape with session.stop probe, Intl.PluralRules count, digit chords via real dispatcher, multi-group cap, scoped console; commit 172cbc5)
Task 22: minor (deferred to final): position tie-break key not provable (stable sort) — weak pin accepted
Task 22: complete (commits 7eae8fd..172cbc5, review clean after 1 fix round)
Task 23: dispatched implementer (sonnet), BASE 172cbc5, agent aab01637ff99d0e86; Ruling: MobileShell lazy behind useIsPhone if phone-only code adds > ~2 KB gz to desktop initial; TabSwitcher lazy (overlays)
Task 23: implementer DONE_WITH_CONCERNS (commit 78902a7; unit 1890, int 198) — initial 189.27 KB gz in 12 JS + 1 CSS (budget 194 unchanged); MobileShell kept static (phone-only ≈ 1.7 KB < 2 KB; lazy variant 187.55 in 14 files + blank frame); MobileShell takes no props; toast keyboard-lift CSS rule unmeasured (no browser)
Task 23: Ruling: phones have no keyboard and no rail → settings/sign-out unreachable; the phone top bar gets a palette (search) button opening the palette (which lists settings + sign-out) — fix in round 1
Task 23: CARRY to Task 32: bundle 189.27/194 (ceiling 200); lever if needed = lazy MobileShell (−1.7 KB, blank frame on phones)
Task 23: task review dispatched (sonnet), diff 172cbc5..78902a7
Task 23: review NEEDS FIXES — 2 Important (--toast-bottom declared on [data-shell=mobile] but Toaster is outside it → bottom:auto, phone toasts off screen; Inbox badge announced as "unread" without the number) + minors; bundle confirmed 188.95 KB gz / 13 files
Task 23: Ruling: data-shell="mobile" set on <html> while MobileShell is mounted (CSS scoped to html[data-shell=mobile], with fallback); one --bottom-nav-height property for nav + toast offset; badge label with count via Intl.PluralRules
Task 23: fix round 1/5 dispatched (resume implementer): palette button (ruling), toast lift, inbox count label, nav-height var, hook test asserts, phone↔desktop test, empty tab sheet; FIX_BASE 78902a7
Task 23: minor (deferred to final, needs a device): section / open tab sheet lost on phone↔desktop switch; 100dvh assumption unmeasured; toast over-lift under pinch zoom
Task 23: fix round 1 implementer DONE (commit 6ca737c; unit 1898, bundle 189.39/194); palette search button already existed on the phone top bar (pinned by test, no new button); nav height property 3rem (unmeasured); scoped re-review dispatched
Task 23: fix round 1/5 (2 Important + minors addressed — html[data-shell=mobile] toast lift with fallback, inbox count label, --bottom-nav-height 3rem, hook read asserts, phone↔desktop test, empty tab sheet; commit 6ca737c)
Task 23: minor (deferred to final): data-shell set in useEffect → first paint without nav height (useLayoutEffect); empty-sheet test en only
Task 23: complete (commits 78902a7..6ca737c, review clean after 1 fix round)
Task 24: dispatched implementer (sonnet), BASE 6ca737c, agent af1c20434fbf1de9a; carried: reuse shared signOut(), Settings lazy chunk + int test, bundle measure (>200 → BLOCKED), phone Select listbox only while open
Task 24: implementer BLOCKED (uncommitted) — initial bundle 217.35 KB gz / 16 files > 200 ceiling; Settings code itself lazy, but Select/ToggleGroup landed in the initial i18n chunk
Task 24: Ruling (controller diagnosis): @pap/ui had no "sideEffects" → barrel re-exports made every primitive statically reachable from the entry; added "sideEffects": ["*.css"] to packages/ui/package.json → initial 11 files ≈ 189.9 KiB gz (below the pre-task 190.4/13), Select only in SettingsScreen chunk. Pin with a build-output int case (data-radix-select-viewport absent from initial JS). Owner not asked: no ceiling crossing remains
Task 24: resumed implementer to commit with the fix + int case + full gate
Task 24: CARRY to Task 32: re-check whether @pap/contracts (zod, ~29 KB gz in runtime-*.js) also benefits from sideEffects; bundle headroom now ≈ 10 KB to 200
Task 24: implementer DONE (commits 4d350d0, eb4a972; unit 1916, build-output int 10/10; initial 190.22 KiB gz / 11 files, budget 194 unchanged); task review dispatched (sonnet)
Task 24: review NEEDS FIXES — 1 Important (LazySettings open=always + onFailed=noop → LazyBoundary.onError retry() loops: blank pane, endless imports/toasts) + minors; sideEffects judged safe, throttle note exact
Task 24: Ruling: always-open lazy panes never auto-retry unbounded — bounded auto-retry (if any) then an in-pane failure state with Retry (or the stale-chunk screen); a reusable LazyPanel mode / pane wrapper for Tasks 25 and 27
Task 24: fix round 1/5 dispatched (resume implementer): pane failure state, phone Select open test, useShell throws outside provider, build-output helper; FIX_BASE eb4a972
Task 24: minor (deferred to final): test bed header repeated in 3 files
Task 24: fix round 1 implementer DONE (commit 4f82065; unit 1923, int 10/10, bundle 190.53/194); LazyPane.tsx (one toast, no auto-retry, in-pane Retry); scoped re-review dispatched
Task 24: fix round 1/5 (Important + 3 minors addressed — LazyPane (one notifyLazyFailure, no auto-retry, in-pane Retry), phone Select open test, useShell throws, keepsLazyOnly helper; commit 4f82065)
Task 24: minor (deferred to final): LazyPane failure state has no role=alert (toast announces)
Task 24: complete (commits 4d350d0..4f82065, review clean after 1 fix round)
Task 25: dispatched implementer (sonnet), BASE 4f82065, agent a4990b288e7c1c10c; carried: Reset keeps custom themes (R3-2), Undo via setters (CAS), markdown + slider lazy-only pins, initial must not move (>194 → BLOCKED)
Task 25: implementer BLOCKED (uncommitted) — initial 194.42 KiB gz / 15 files > 194 (baseline 190.53/11); provisional ×1.05 would be ~204 > 200 ceiling. AppearancePanel imported from its own file (web barrel pulled it eager)
Task 25: controller diagnosis — settings catalog gz 484 → 2112 B (+1.6 KB, both locales eager) + ~2 KB fragmentation (11 → 15 files); Tasks 26/27 add more Settings-only strings
Task 25: Ruling: Settings-only strings move to a lazy catalog (catalog/settings-screen.ts) registered at Settings chunk evaluation via i18n registerCatalog (MessageKey keeps them at type level via import type); source-scan guard that lazy keys are used only inside the Settings chunk; build-output lazy-only marker for a settings-screen string. Budget stays 194; still above → BLOCKED → ask owner
Task 25: resumed implementer with the ruling
Task 25: CARRY to Tasks 26 + 27: their Settings-only strings go to catalog/settings-screen.ts (lazy), never the eager catalogs
Task 25: implementer DONE_WITH_CONCERNS (commit d80a012; unit 1942, build-output int 13/13; initial 192.66 KiB gz / 15 files ≤ 194) — whole catalog/settings.ts → lazy catalog/settings-screen.ts (all settings.* keys Settings-only); registerCatalog + type-only MessageKey; translate no longer throws on a missing key: shows the key + reports message_missing
Task 25: flaky observed: packages/ui Markdown.test.tsx (full run only) "expected 'hi there' to contain '**hi** there'" — first textContent assertion races the lazy import → fix in the T25 fix round or carry
Task 25: task review dispatched (sonnet), diff 4f82065..d80a012
Task 25: review NEEDS FIXES — 2 Important (I-1 scan guard exempts all features/appearance incl. eager boot files; I-2 Undo after a conflicting/failed reset save untested) + minors; message_missing rate-limited, throw→fallback accepted
Task 25: Ruling: Undo restores the fields the reset changed and never customThemes (reset keeps them; avoids wiping a theme edit made within 5 s once Task 26 exists)
Task 25: fix round 1/5 dispatched (resume implementer): I-1 explicit lazy file list, I-2 conflict/failure tests, M-1 ruling, M-2 density defaults tied to tokens.css, Markdown flake (deferred vi.mock), direct SettingsScreen registration test; FIX_BASE d80a012
Task 25: fix round 1 implementer DONE (commit c1bd847; unit 1949, int 13/13, bundle 192.67/194); scoped re-review dispatched
Task 25: fix round 1/5 (2 Important + minors addressed — explicit lazy file list, conflict/failure Undo tests, Undo keeps customThemes, density defaults tied to tokens.css, deterministic Markdown test, direct registration test; commit c1bd847)
Task 25: minor (deferred to final): lazy-file exempt list has no existsSync check (stale entry silently exempts nothing); Markdown gate not released in finally; slider snapping at a 12.5 start (ArrowRight → 14)
Task 25: complete (commits d80a012..c1bd847, review clean after 1 fix round)
Task 26: dispatched implementer (sonnet), BASE c1bd847; carried: strings in settings-screen.ts + exempt list (+ existsSync check from T25), ThemeEditor lazy + build marker, file.size before text(), Blob URL revoke, M3-RT-32 duplicate test, >194 → BLOCKED
Task 26: implementer DONE_WITH_CONCERNS (commit 76a068b; unit 1983, int 204; initial 192.85 KiB gz / 16 files ≤ 194) — TextField now a shared 1.4 KB chunk (login + editor); Blob URL revoked synchronously after click; editing a selected theme to the other base sends that side back to its preset (extra behaviour); exempt-list existsSync added
Task 26: task review dispatched (sonnet), diff c1bd847..76a068b
Task 26: review NEEDS FIXES — 1 Important (Blob URL revoked synchronously after click: can cancel the download on Safari 16.4 / Firefox) + minors; untrusted import order, hex-only styles, ids, presetRoles, contrast all verified
Task 26: Ruling: revoke via an injectable scheduler, default setTimeout 40 s (FileSaver.js precedent); Undo never silently no-ops (re-add under a fresh id or toast); saving an edit of a theme deleted meanwhile never closes as success
Task 26: fix round 1/5 dispatched (resume implementer); FIX_BASE 76a068b
Task 26: minor (deferred to final): TextField shared chunk (+0.18 KiB, +1 file); index keys on the capped error list
Task 26: fix round 1 implementer DONE (commit b691193; unit 1993 ×3, int 204, bundle 192.85/16); test split + theme-fixtures.json (hex literals out of a .ts test because of the no-raw-colors lint); cold-transform timeout worked around by importing ThemeEditor first; scoped re-review dispatched
Task 26: fix round 1/5 (Important + minors addressed — scheduled revoke 40 s, fresh-id Undo + limit toast, deleted-theme save re-adds or keeps editor open, pinned paths, no Date.now fallback; commit b691193)
Task 26: minor (deferred to final): hex fixtures in theme-fixtures.json dodge no-raw-colors (cleaner: add **/theme-test-kit.ts to the test ignore block)
Task 26: note: re-reviewer briefly edited theme-io.ts in place (restored via git checkout; tree verified clean) — reviewers must use scratch copies
Task 26: complete (commits 76a068b..b691193, review clean after 1 fix round)
Task 27: Ruling: editor-only strings → catalog/settings-screen.ts (not eager commands.ts); ShortcutsEditor NOT exported from the eager features/commands barrel (imported from its own file) + build-output lazy marker; shared download helper extracted from theme-io (scheduled revoke); budget: >194 → provisional min(×1.05, 200), >200 → BLOCKED
Task 27: dispatched implementer (sonnet), BASE b691193
Task 27: implementer DONE_WITH_CONCERNS (commit 3e0fd9c; unit 2028 ×2, build-output 15; initial 192.61 KiB gz / 15 files) — one uncaptured unit failure in an earlier full run (flake watch → final review); brief's Ctrl+B conflict example doesn't conflict under conflictsOf (different when) → test uses Ctrl+, ; lib/download-file.ts shared; import applies at once
Task 27: task review dispatched (sonnet), diff b691193..3e0fd9c
Task 27: review APPROVED with 1 Important against Task 16b (conflictsOf misses overlapping-but-different when clauses: user Ctrl+B on palette silently shadows tree toggle) + minors (fake timers / URL stub hygiene = likely flake source; import with zero valid entries clears all bindings silently; AltGr message; dead settings.soon)
Task 27: Ruling: conflict = warn unless provably exclusive (an atom top-level conjunct in one clause and negated top-level conjunct in the other; any ||/parens → warn); empty-valid import never applies silently; imports get Undo like Reset all
Task 27: fix round 1/5 dispatched (resume implementer); FIX_BASE 3e0fd9c
Task 27: minor (deferred to final): row handlers use render-time user (resetAll uses getState); import .catch untested; RED was one module-missing failure (mutations cover the rest)
Task 27: fix round 1 implementer DONE (commit 5363603; unit 2037 ×3, build-output 15, bundle 192.70/15); scoped re-review dispatched
Task 27: fix round 1/5 (Important + 4 minors addressed — conflictsOf warns unless provably exclusive, timer/URL spy hygiene, import guard + Undo, AltGr messages, dead key; commit 5363603)
Task 27: minor (deferred to final): recorder AltGr message inferred from platform+ctrl+alt instead of getModifierState("AltGraph"); JSON ctrl+alt warning also on Linux where it works ("may never")
Task 27: complete (commits 3e0fd9c..5363603, review clean after 1 fix round)
Task 28: Ruling: gallery strings leave the eager catalog (lazy catalog registered by the gallery module); build-output asserts a gallery marker + string absent from EVERY prod asset; a primitive failing the 44-px class probe is fixed, never the probe weakened
Task 28: dispatched implementer (sonnet), BASE 5363603
Task 28: implementer DONE (commit f7f0e79; unit 2060 ×2, build-output 16; bundle 192.70/15); eager key shell.tab.devUi for the tab title; no primitive failed the probe; task review dispatched (sonnet)
Task 28: review NEEDS FIXES — 1 Important (portaled Dialog/Menu/Select/Tooltip/Toast render in the app theme, not the frame's; undocumented) + 7 minor; dev-only gating verified on a real build (no gallery marker/strings in prod except the eager tab title)
Task 28: Ruling: document the portal limit (ADR 0011 + visible gallery note) — no portal-container plumbing for a dev-only tool; prod dev-ui item takes the not-found title
Task 28: fix round 1/5 dispatched (resume implementer); FIX_BASE f7f0e79
Task 28: fix round 1 implementer DONE (commit f32d550; unit 2065 ×2, build-output 16, bundle 192.70/15); Menu primitive gains optional onOpenChange; catalog/dev.ts DEV-only; scoped re-review dispatched
Task 28: fix round 1/5 (Important documented + 6 minors addressed — ADR limits + note, Icon shown, prod title + DEV-only catalog/dev.ts, exact probe 68 after Markdown, Menu onOpenChange, unique ids; commit f32d550)
Task 28: minor (deferred to final): probe failure message should list probed items by data-gallery-item
Task 28: complete (commits f7f0e79..f32d550, review clean after 1 fix round)
Task 32: Ruling (amends M3R126): final budget = min(ceil(measured × 1.10), 200); measured ≈ 192.7 → ×1.10 ≈ 212 → capped at 200 = the owner's own target (agreement 10 asks the owner only above 200); flagged in the final report; P6 post-merge re-measure (M2 + M3) is where an owner question may arise
Task 32: Ruling: measure the contracts sideEffects lever (keep only if it shrinks and tests pass); no zod/mini, no lazy MobileShell, no JS file-count pin; docs/agents/web.md Modify (exists since Task 13)
Task 32: dispatched implementer (sonnet), BASE f32d550
Task 32: implementer DONE (commit 3c036f3; all gates pass: unit 2067 ×2, int 207, smoke, budgets 192.1/200); budget final 200 (×1.10 = 212 capped); contracts sideEffects:false kept (192.4 → 192.1); docs/agents/web.md 65 lines; task review dispatched (sonnet)
Task 32: review APPROVED (scratch rebuild reproduced 192.1 / 192.4; contracts sideEffects safe; doc claims spot-checked)
Task 32: CARRY to M3 final review: (pre-existing) zod schemas constructed before z.config({jitless}) in the bundle — the shared chunk with zod + contract schemas evaluates before csp-safe-zod's body → one string-eval attempt / CSP violation per load; csp-safe-zod.test only proves source order. Suggested fix: web-only Vite alias of "zod" to a wrapper that re-exports zod and calls config({jitless:true}) right after zod evaluates (no contracts change, no M2 conflict) + a build-level test
Task 32: minor (deferred to final): web.md says features/sessions "is scanned from P7" (reads as done; it is excluded until P7); lazyAssets fixture has one lazy js (css and sort order unpinned)
Task 32: complete (commit 3c036f3, review clean)
M3 final: whole-branch review dispatched (OPUS per X2), range f765f2a..3c036f3 (58 commits, 336 files)
M3 final: Opus whole-branch review — ready after fixes: 0 Critical, 5 Important (I1 CSP violation per load: zod schemas before jitless — introduced by M3's chunking, daemon logs no CSP reports; I2 blank pane after closing last tab at /; I3 Rail/PaneHost menus bypass LazyBoundary; I4 shortcuts help/overlays not pinned lazy; I5 custom themes lost across devices — field-level merge), 12 Minor; gate all green (unit 2067 ×4, int 207, smoke, budgets 192.1/200); trial merge with M2@7d5892a: only the 3 predicted conflicts, merged 195.2 KB; P6 risk > 85 % of > 200 without levers
M3 final: Ruling: I5 fixed now (three-way merge by theme id, base = last adopted server value); keybindings list same shape → documented limit, carried
M3 final: Ruling: lever 1 applied now on M3 — SessionScreen lazy via LazyPane (merged tree 195.2 → 190.5); lever 2 → M2 carry (keep stores lean, no overlays outside features/sessions)
M3 final: fix batch dispatched (fresh sonnet implementer): I1–I5, lazy SessionScreen, m1–m8, m12; carried: m9 (multi-user), m10 (M5), m11 (P7), triage C rows (P1–P7/M4/M11/browser e2e)
M3 final: merge notes for later: P7 removes THREE exclusion copies (compiler-gate.test.ts:11 too); don't re-stamp the M3 settings migration unless M2's final stamp sorts later (read-only PAP_HOME risk); contracts sideEffects:false not in conflict tables; ApprovalAnswer exported by both @pap/ui and @pap/contracts (P3 aliases one); P3 musts: ToolCard name min-w-0 truncate, highlight settled fences only
M3 final: fix batch DONE (15 commits 3c036f3..e61b01b; unit 2086 ×2, int 210, smoke, budgets 189.7/200 in 17 files); isStaleChunk looks into error.cause; probe accepts w-full rows; rebase hints: Toaster regionLabel, merge 4th base arg, LazyPanel moved to lib/; Opus re-review dispatched
M3 final: Opus re-review — I1–I5, m1–m8, m12 confirmed; gate green (unit 2086 ×3, int 210, budgets 189.7/200); trial merge with M2 (1a–17a): 191.6 KB, green; P6 estimate 195–198 KB, 10–15 % risk of > 200 (was > 85 %)
M3 final: NOT merge-ready yet — N1 Important (new lazy() per tab switch → ~300 ms blank pane on every session/settings tab switch; React 19.3 fallback throttle) + N2 (I1 build test vacuous if zod chunk has no schemas) + N3 (same-id theme adds across devices) + N4 (Checkbox 44 px on a non-clickable div) + nits
M3 final: Ruling: N3 → re-id the local theme on a same-id/different-content collision (canonical compare), selection follows; server-without-document keeps cached themes as local adds; cap drop shows a notice
M3 final: round 2 dispatched (resume fix implementer); rebase notes go into the plan's merge-notes section (committed)
M3 final: CARRY to the post-merge P-list: move M2's session-screen strings to a lazy catalog registered by the session chunk (~3 KB, biggest remaining P6 lever)
M3 final: round 2 DONE (e61b01b..ebb2a77; unit 2095 ×2, int 210, budgets 191.4/200 (+1.7 KB: newThemeId + canonical compare + toast text now eager)); Opus re-review of round 2 dispatched
M3 final: Opus round-2 re-review — MERGE-READY (no Critical/Important); N1–N4 + nits fixed; gate green on branch and on a trial merge with M2@1fea310 (unit 2834, int 262, budgets 193.3); P6 estimate 197–199 (~25 %), 196–198 with theme-ids split (~15 %), 193–195 with M2 session strings lazy (< 5 %)
M3 final: Ruling: R2-1 cap-drop notice → reviewer's rule (edited here AND merged list > 16 before parseAccount); R2-2 → doc line (narrow guarantee for cache-only themes), no first-contact write; R2-6 theme-ids.ts split (−988 B); R2-3, R2-5 accepted as is
M3 final: round 3 dispatched (resume fix implementer): R2-1, R2-2 doc, R2-4 rebase-hint corrections, R2-6 split
M3 final: round 3 DONE (25402cb theme-ids split −988 B → 190.4 KB/17 files; 3e56b17 mergeCutsThemes cap notice, 4 review cases + quiet case; b3c98d1 docs; unit 2098 ×2, int 210, smoke, budgets green; controller-verified small diff)
M3: COMPLETE and merge-ready at b3c98d1 — waiting for M2 (merge order M2 first, owner T3); then rebase on main, re-run the gate, run P7 → P3 → P2 → P1 → P4 → P5 → P6, ask the owner before merging
POST-MERGE CARRY (from M2 Task 28a): M2's inline rename field (data-inline-edit) — add a dispatcher context key inlineEditFocus = active.closest("[data-inline-edit]") and "!inlineEditFocus" to the escape → session.stop rule (dispatcher listens on window capture, so the field's stopPropagation cannot stop it); test Escape in the rename field cancels the rename and never stops the run
POST-MERGE CARRY detail: data-inline-edit is on the rename field's WRAPPER div (M2 TextField takes no attributes) — the inlineEditFocus key must use active.closest("[data-inline-edit]")
REBASE CHECKLIST (from the M2 final review I2, semantic conflicts outside both tables): (a) M2 made SessionSummary.name required → 4 M3 shell test files break; tabs/palette/rail show name ?? basename(cwd); (b) Composer.test.tsx:102-111 and ApprovalDialog.test.tsx:77-81 assert old M1 button class names → re-assert M3's; (c) M3 deleted i18n/i18n.test.ts → move M2's plural test into i18n.test.tsx; (d) P4 coded server texts must include M2's notice emitters in grants.ts, panels.ts, service-commands.ts, live-session.ts (+ status.cause, M2 final M9)
REBASE CHECKLIST (I3): the inlineEditFocus rule must exempt [data-inline-edit] on M2's rename wrapper, ExtensionCard and ApprovalDialog roots; test Escape in each cancels/stays and never stops the run
MERGE FACTS (M2 final review): trial merge conflicts in 8 files (AGENTS.md, daemon.ts, SessionScreen.test.tsx, i18n.test.ts modify/delete, budgets.json, methods.ts, permissions.ts, check-budgets.ts); lockfile consistent; migrations order holds (no re-stamp); TextField placeholder already in M3; merged bundle 191.0/200
M3 REBASE: dispatched (sonnet implementer) onto main b718f9c (M2 merged --no-ff, owner-approved); then P7 → P3 → P2 → P1 → P4 → P5 → P6 (plan: Sonnet impl + Sonnet review each), then ask the owner before merging M3
M3 REBASE: DONE — head df9de7b, 84 commits above main (83 rebased + fix: adapt M3 to M2 after the rebase); gate green (unit 3425, int 292, smoke, budgets 191/200); lockfile unchanged; conflicts resolved (incl. TextField.test both tests kept); session-label.ts name ?? basename(cwd); tests assert data-variant; plural test moved; trap: run pnpm build before typecheck after a rebase (stale contracts dist)
M3 REBASE: conflict-resolution review dispatched (sonnet); P7 dispatched (sonnet) — P-task briefs extracted to p-tasks-brief.md
M3 REBASE: review OK — no lost intent from either side (all conflict files + auto-merged knip/daemon.md/i18n/TextField checked; lockfile = M3 + M2's 6 pi-tui lines); minor: unnamed tree rows show the id while tabs show the folder
P7: implementer DONE (commit e62ca06; unit 3449, int, smoke, budgets green) — 3 exclusion copies removed; TONES → SGR_COLOURS; 5 session files restructured for React Compiler bailouts (try/finally, value blocks in try, destructured defaults); compiler-gate failing fixture added; review dispatched (sonnet) with focus on behaviour equivalence of the restructured try/finally
P7: controller review (14 KB diff): try/finally → post-try statements are equivalent as long as the catch blocks cannot throw (they only set state / map codes); DialogList default-param → explicit; prepend() extraction verbatim; gates now scan M2's folder — APPROVED
P7: minor (deferred to final): a throwing catch would now leave inFlight set (no finally)
P7: complete (commit e62ca06, controller-reviewed)
P3: dispatched implementer (sonnet), BASE e62ca06; carried: inlineEditFocus context key + escape rule (I3/T28a), ApprovalAnswer alias, ToolCard min-w-0 truncate + error/header tests, settled-fence highlighting, ApprovalCard header/aria-describedby, adoption items (branch position announced, hostile Fence, RunStatus, MessageActions, AuthorGroup), M2 behaviours preserved
- 2026-10-12 controller: origin = github.com/SoulKyu/pi-agentic-platform (private). main moved to 175a8bf (root README + docs/brand/pap-mark.svg, copy of apps/web/public/favicon.svg). Before merge: rebase M3 on main, push feat/m3-design with --force-with-lease, push main after merge.
P3: implementer DONE_WITH_CONCERNS (6 commits e62ca06..6c4b0a3; unit 3507, int 292, smoke, budgets 194/200; SessionScreen chunk 27.8 KB) — concerns: eslint web-root may import contracts; command registry + useCommand moved to lib/, tool detail as a prop from pane-renderers; tool output folded by default; markdown drops raw HTML; Escape-to-stop live for the first time; TDD gaps covered by mutation; transcriptItems t mutation survives; review dispatched (sonnet)
P3: review (sonnet) CHANGES REQUIRED — 0 Critical; carries 1–7 hold; concerns a–e, g accepted; bundle +2.6 KB = chunk-graph reshuffle (runtime/react-dom/TextField/preload-helper preloaded), not a new import → P6
P3: Ruling: mod+shift+enter (session.sendOther) is ONE-SHOT — sends this message the other way, never saves the default (split-button choice stays the persistent selector, M2 970d8c5); avoids the steer/follow-up alternation
P3: Ruling: raw HTML in model text renders as literal text (html nodes → text), not dropped — "Array<string>" outside backticks must not lose "<string>"; never rendered as HTML
P3: Ruling: palette "Stop the run"/"Send the other way" target the session focused before the palette opened (else the active pane); sendOther when-rule gains !inlineEditFocus && !overlayOpen && !dialogOpen
P3: fix round 1 dispatched (resume implementer): I1 palette/sendOther scope, I2 one-shot, I3 toolDetail wiring test, minors (translate required, html→text, docs/agents/web.md, IME ctrl+shift+enter test, aria-describedby without toggle, no "finished" announce on running→cold); deferred: streaming-partial key remount (M2 same)
P3: fix round 1 DONE (d7830d1; unit 3520, int 292, build, budgets 194/200; smoke not re-run → final gate); scoped re-review dispatched (sonnet)
P3: re-review (sonnet) APPROVED — all 6 rulings met; smoke ok in copy; deferred minors: last-screen keeps one detached subtree until next focus (bounded), no sendOther overlay/dialog test (same when-pattern as escape, tested), Markdown re-parses the whole text per streaming delta (pre-existing; ~hundreds of ms near the 100 KB cap → M4 carry)
P3: complete (d7830d1)
CARRY (final report / M4): two sources of the session list coexist — routes/shell/sessions-cache.ts and features/sessions/SessionListScreen.tsx (+ AlwaysRules) each call sessions.list (final review P3 note; not in P3's carries); unify via a lib/ cache in M4
P2: dispatched implementer (sonnet), BASE d7830d1; carried: subpath + lazy boundary, never the eager barrel (final review), no contracts dep in ui, data-inline-edit / data-terminal-input / focus / IME preserved, budgets BASE vs HEAD
P2: implementer DONE_WITH_CONCERNS (1ee3e87, 3f619a2; @pap/ui/extensions subpath, imported only by lazy SessionScreen; AnsiText/ansi/terminal-keys moved too; unit 3536, int 293 (1 known flake, rerun green), smoke, budgets 194/200 unchanged; build-output test pins extensions out of initial assets) — concerns: panel textarea lacked coarse 44 px (fixed, probe 68→79); M1 aliases → DESIGN names in moved markup (status label 600, focus ring on expanded region); review dispatched (sonnet)
P2: review (sonnet) APPROVED + 1 Important (build-output guard misses StatusBar/AnsiText: no marker) + minors (3 weakened assertions, panel textarea pointer-coarse:text-base, SelectDialog fallback fail-closed); fix round 1 dispatched (resume implementer); visual deltas accepted (same variables, 600 per DESIGN, ring fixes a ringless focusable)
P2: fix round 1 DONE (cf32de0; markers data-slot status-bar/ansi-text in keepsLazyOnly, eager-import proof, 3 assertions restored, pointer-coarse:text-base, SelectDialog fail-closed; unit 3540, int 293, budgets 194) — controller-verified small diff; P2 complete
P1: dispatched implementer (sonnet), BASE cf32de0; widened to apps/web/src + packages/ui/src (final review m4/P1 note); Ruling: m11 i18n disjointness test folds into P1 (P7 missed it); no invented alias mapping — stop and report
P1: implementer DONE (2bff1f5, 2dae4c5, 15e5060; 12 aliases → exact DESIGN equivalents; ApprovalCard M1 props dropped; i18n catalog-keys disjointness test; unit 3546, int 293, smoke, budgets 193.9/200); review dispatched (sonnet)
P1: review (sonnet) APPROVED (0 C/I; minors: literalKeys regex assumes prettier 2-space keys — accepted, prettier enforces it; historical plan text left); trailers checked by controller (0); P1 complete
M2 deferred #44/#46 (carried to P3, not in P3's brief): #46 RESOLVED (Transcript preserve() now runs after the await, nothing to release on failure); #44 truncation note + live regions done; Ruling: #44's "stale may-have-been-sent after a remount" folds into P5 (same stores/composer area)
P4: dispatched implementer (sonnet), BASE 15e5060; grep for every notice/cause emitter (minimum list exit.ts, grants, panels, service-commands, live-session); code optional in schema; Pi/extension text untranslated (R66); strings lazy where possible; budgets BASE vs HEAD
P4: implementer DONE_WITH_CONCERNS (c3f7157; 19 SERVER_CODES; optional code/params on notice, causeCode/causeParams on status; server.* strings moved to lazy catalog/server.ts; translation at render time so stored notices follow a locale switch (accepted); unit 3564, int 293, smoke, budgets 194.7/200 (+0.8 schema fields)); review dispatched (sonnet)
P4: review (sonnet) APPROVED (0 C/I; no missed emitter; lookup restricted to server.* table; params bounded 4×64) — minors fixed in round 1 (raw {slot} → English fallback, two-way code-list test, 3 negative tests incl. extension-source+code); accepted: strict params schema (web+daemon ship together)
P4: fix round 1 DONE (bdc7a40; controller-verified: slot check → English, translatedServerCodes two-way test, negative tests; unit 3569, budgets 194.7); P4 complete
P5: dispatched implementer (sonnet), BASE bdc7a40; R129 items (check M2 first, close with test if resolved) + M2 deferred #44 stale 'may have been sent' after remount
P5: implementer DONE_WITH_CONCERNS (869f8e9 keyMessages running Map + role:none no content dedup; 8fea4d5 onPendingChange listener so a mid-flight-mounted screen drops a stale banner; unit 3580, int 293, smoke, budgets 194.7) — concerns: no reducer-level cost test (ESM spy), mounted screen doesn't reload the returned draft after a definite failure (pre-existing); review dispatched (sonnet)
P5: review (sonnet) APPROVED + 1 Important (returned text lost on next keystroke after a definite failure on a mid-flight-mounted screen: stale textRef overwrites the stored draft) → fix round 1 dispatched (saveDraft before remember(null), listener reloads + merges like giveBack, loadPending malformed drop silent); accepted: clearSessionDrafts no notify, no reducer-level counting test, other tabs; role:none dedup drop only affects timestamp-less messages (R129 trade-off)
P5: fix round 1 DONE (27490e2; draft stored before remember(null), listener commits the returned draft, loadPending malformed drop silent; unit 3583, budgets 194.7) — controller-verified; P5 complete
P6: re-measure on merged code = 194.7 KB gzip; Ruling (same as Task 32 amendment of M3R126): budget = min(ceil(194.7 × 1.10)=215, 200) = 200, unchanged → no commit; owner informed in the merge question (5.3 KB headroom)
M3: rebased on main 12a7a3b (README 175a8bf + design explorations index 12a7a3b, docs only) — clean, 104 commits, head 7580248; full clean-env gate running
M3: final gate GREEN at 7580248 (clean env: build, lint, format, typecheck, knip, unit 3583, int 293, smoke, budgets 194.7/200); feat/m3-design pushed --force-with-lease; asking the owner to merge
M3: MERGED into main a2b214f (--no-ff, owner-approved), pushed to origin
