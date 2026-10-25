# SDD ledger — plan: docs/plans/2026-10-24-design-impeccable.md

Spec: the v2 audit (`audit.txt` here; `docs/research/design-audit-impeccable-v2.html`), DESIGN.md, ADR 0012, decisions 27/28. Owner answers: decision 131 (D1–D8 = recommendations; run « Go après la fusion de M14, Sonnet + une revue finale Opus »).
Start: main 708d3ddb (M14 7ea23ea0, image-entries fix f9079868, code-block copy button 0a61000b). Initial bundle at start: 244.9 KB gzip (plan said 244.7; stop above 248.5).
Worktrees: join /home/ubuntu/Workspace/soulkyu/pap-design (feat/design-impeccable); lane A pap-design-a (feat/design-impeccable-a); lane B pap-design-b (feat/design-impeccable-b), both from S2.
Execution: S1 → S2 on the join; then lanes A (A1–A6) and B (B1–B13) in parallel (separate worktrees, heavy-gate flock), one implementer at a time per lane; J1 merges; J2 Opus final review.

## Pre-flight scan

| Pair / task | Produces → consumes | Found |
|---|---|---|
| S1 → A5, B1, B8, B13 | `max-w-measure`, `max-w-settings`, `max-xs:`, `data-prose`, 8 icon names | consistent |
| S2 → A3, B1–B10, B12 | InlineError, DeferredFallback, CodeText, Heading, EmptyState level, Segmented label, Switch meta, Icon filled, duplicateNames | consistent; S2 also edits apps/web (names.ts, gallery, broken Segmented tests) before the split, as stated |
| A2 → A4 (terminal-theme.ts) | A2 black → text-muted; A4 rebuilds the palette | sequential in lane A; A4 test "only pap tokens" holds |
| A3 ↔ A5 (TextField, Switch) | A3 InlineError + hit area; A5 `text-pretty` hints | sequential in lane A |
| S2 ↔ A3 (Switch.tsx) | S2 `meta`; A3 coarse hit area | sequential (S2 on join) |
| A5 ↔ main 0a61000b (render.tsx, CodeBlock.tsx) | copy button wraps the `pre` in a `relative` div when labels are set | see Ruling R3 |
| A6 ↔ all | DESIGN.md text describes D1–D8 and the lanes' changes, written before lane B lands | J1 re-reads DESIGN.md against the merged code (plan says so) |
| B1 ↔ B2 ↔ B3 (routes/settings, appearance) | B1 frame; B2 contents + data-prose; B3 headings | sequential in lane B |
| B5 ↔ B6 (sessions headings, SessionScreen header) | B5 converts h2–h4; B6 the h1 | sequential |
| B8 ↔ B13 (LaneRow.tsx) | B8 drops rounded-sm; B13 IconDot | sequential |
| B9a → B9b → B9c | alert-allowlist.ts + inline-error.test.ts widen per part | sequential |
| B11 ↔ B12 (en.ts/fr.ts, catalogs) | B11 error copy; B12 sentence case, fr spacing, backticks | sequential; B12 must keep B11's exact values |
| B7 (build-output.markers.ts) | in apps/web/src: lane B owns it | consistent |
| J1 ↔ pap-design-audit worktree | the screenshot pass worktree | see Ruling R1 |
| each task, self-consistency | tests named vs files created | no contradiction found; every task's tests target files it lists |

Ruling R1: J1 recreates /home/ubuntu/Workspace/soulkyu/pap-design-audit (detached at the branch head) — it was removed after M14 as clean scratch — cost if wrong: none.
Ruling R2: the bundle baseline is 244.9 KB (M14 + the code-block copy button), the stop threshold stays 248.5 and the J1 target ≤ 249 — the owner's budget is unchanged — cost if wrong: 0.2 KB less headroom.
Ruling R3: A5 keeps code blocks full width including the copy button's `relative` wrapper (main 0a61000b); A6 adds "code blocks carry an always-visible copy button" to DESIGN.md §9.2 so the doc matches the code — cost if wrong: one doc line.
Ruling R4: B12's `CODE_COPY_KEYS` (catalog values with backticks) is unrelated to the code-block copy button; `sessions.code.copy`/`copied` are plain values — cost if wrong: none.
Ruling R5: J2's Opus final review is confirmed by the owner's form answer « Sonnet + une revue finale Opus » — cost if wrong: none.
Ruling R6: lanes A and B run in parallel in separate worktrees (owner-approved "2 lanes + flock", as in M14); within a lane, one implementer at a time — cost if wrong: none.

## Progress
S1: dispatched (base 708d3ddb, implementer af13020d145308bc3)
S1: implemented ea813a59 (59 tests; bundle 244.9 KB; tokens.css 336)
Task S1: minor (deferred): export order of the new icons; IconFailed === IconClose assertion; exact `width < 25rem` match
Task S1: complete (commits 708d3ddb..ea813a59, review clean)
S2: dispatched (base ea813a59, implementer a22a9ed5abe40d6c3)
S2: implemented d684108f (related 390 files 3378 tests; bundle 245.2 KB). Concerns: Switch coarse target via before: box (gallery isCoarseTarget + AvailabilitySection test updated, PROBED_CONTROLS 82); EmptyState backticks → code (2 web tests updated); segmentedGroup(root,label) helper added to testing/names.ts (4 tests use it); RunsAsField.test toBeNull check is vacuous (left); RED lines not pasted in the report
Main moved meanwhile (owner requests): a76cea73 (one copyText in @pap/ui for every copy button, HTTP fallback) and 80b04c00 (files: unsure save confirmed by re-reading text, no crypto.subtle).
Ruling R7: merge main into feat/design-impeccable after S2's review and before the lanes split, so both lanes start with a76cea73 and 80b04c00 (index.ts, CodeBlock.tsx, use-save.ts) — cost if wrong: one merge commit on the join.
S2: review: spec ✅ (caveat I1 from the brief's values), quality needs fixes: I1 Switch coarse hit area 42 × 42 (Switch.tsx:39: before: box is placed against the padding box 30 × 14 inside a 1 px border; plan insets 6/14 px → 42); 7 minors
Ruling R8: the Switch's coarse hit area must measure 44 × 44 (DESIGN.md "targets are 44 px under a coarse pointer" binds over the plan's -inset-x-1.5 -inset-y-3.5, which forgot the 1 px border): insets 7 px / 15 px (`-inset-x-1.75 -inset-y-3.75`), with a test that computes the box from the classes and the border — cost if wrong: 2 px of hit area.
Carry to B5: Heading's card variant renders an h4 with label-hud inside packages/ui; the apps/web guard scans web sources only, so `<Heading variant="card">` is not flagged — keep it that way.
S2: fix round 1 dispatched (I1 per R8)
S2: fix round 1/5 (1 addressed, 0 open — I1 44 × 44 via -inset-x-1.75 -inset-y-3.75 + computed-size test; commits d684108f..64f3ccf8, controller check (tiny fix, owner-approved lightening))
Task S2: minor (deferred): 7 minors in task-S2-review.md (incl. m5 the Availability test now accepts either class pair)
Task S2: complete (commits ea813a59..64f3ccf8, 0 parked)
Join: main merged (e88b7c2b, no conflict; typecheck + ui/primitives/markdown/clipboard/files-edit 30 files 185 green). Lanes created at e88b7c2b: pap-design-a (feat/design-impeccable-a), pap-design-b (feat/design-impeccable-b).
A1: dispatched (base e88b7c2b, implementer ad664fe0c1a40f6ae)
B1: dispatched (base e88b7c2b, implementer adc5c0d1332e508d6)
A1: implemented ba35ee7a (26 tests; RED 3). Concerns: DESIGN.md lines 129/164 still old values → A6; code/review-gutter.ts:105 letterSpacing "0.12em" hard-coded (CodeMirror style) → A2 (it edits review-gutter.ts) to align with the label token
Task A1: minor (deferred): review-gutter.ts:105 letterSpacing 0.12em (carried to A2); whitespace-sensitive label-hud regex in the test; 11 px fit in Badge (16 px), Avatar, Wordmark tagline, tight chips → J1 visual check
Task A1: complete (commits e88b7c2b..ba35ee7a, review clean)
A2: dispatched (base ba35ee7a, implementer a0544431f7880386c)
A2: implemented acaeff1a (related 387 files 3417 tests; RED 7). Notes: gutter tracking var(--tracking-label, 0.08em); ADR 0012 text still #ea580c → A6 (amended by ADR 0086 header line); AnsiText.tsx comment reworded for the dim guard
B1: implemented 9a1c90b1 (bundle 245.4 KB). Concerns: SettingsToolbar in lib/ (boundaries forbid feature → routes import); no RED evidence captured; settings.appearance.title orphan (used as a sample key by settings-catalog.test); J1: grep scripts/e2e for "Personal" and the Automation h2
Task A2: minor (deferred): dim-tone test also exempts its own test files; redundant disabled: window check; Avatar exemption by file (a second bg-dim would pass); ring checks presets only (custom themes = B13)
Task A2: complete (commits ba35ee7a..acaeff1a, review clean)
A3: dispatched (base acaeff1a, implementer afd8cbb1a37c3ffb7)
B1: review: spec ✅, quality needs fixes: I1 inner caps keep 5 widths inside the 48rem column (max-w-xl NotificationsPanel:196,264, ClassToggles:20, DevicesList:43, AutomationForm:156; max-w-prose GithubSettings:116; max-w-3xl SpendingPanel:45) — exactly the audit's measured 520/576/768; 4 minors; SettingsToolbar in lib/ accepted (boundaries)
Ruling R9: B1 removes the inner width caps of column sections (audit change 6 "une largeur de colonne", F18: GitHub 520 = max-w-prose, Automation 576 = max-w-xl) although the plan's B1 file list did not name them — the audit is the spec and the plan's intent is one width — cost if wrong: some forms read wider (≤ 48rem).
Ruling R10: SettingsToolbar lives in apps/web/src/lib/SettingsToolbar.tsx, not routes/settings/ (the eslint boundaries rule forbids a feature importing routes) — cost if wrong: none.
Carry to B3: ShortcutsEditor's h2 repeats the h1 (F23 pattern) — B3 converts Settings headings; drop or rename it there.
Task B1: minor (deferred): member test doesn't assert You and Work present; column-body test covers Approvals only, never checks split sections have no wrapper; settings.appearance.title unused by the UI
B1: fix round 1 dispatched (I1 per R9)
B1: fix round 1/5 (1 addressed, 0 open — I1 per R9: 6 caps removed, settings-width.test.ts guard, RED captured; commits 9a1c90b1..955b9c86, controller check (tiny fix)); bundle 245.4 KB
Task B1: complete (commits e88b7c2b..955b9c86, review clean)
B2: dispatched (base 955b9c86, implementer a9431a015d78097a3)
A3: implemented fa6247a2 (ui 438 green; RED 9). Concerns: ApprovalCard default level 2 (was h3) breaks 7 apps/web tests (SessionScreen.dialogs 4, SessionScreen 1, ApprovalCardFor 2) — lane B lacks A3, so they fail only after the J1 merge; Reasoning keeps an ignored `streaming` prop
Carry to J1: after merging lane A, ApprovalCard renders h2 by default — move the 7 web tests to h2 (the card sits under the session's h1), or pass level={3} where it sits under a section h2
Task A3: minor (deferred): Reasoning `streaming` still required and unread (make optional, drop at web call sites at J1); 3 more in task-A3-review.md
Carry to B10 (loading copy): `sessions.transcript.thinking` lacks "…" (EN "Thinking", FR « Réflexion ») — B10's ellipsis guard should catch it
Carry to J1: check MessageRow keeps one React key from the streaming partial to the final message, else an opened Reasoning block closes at the stream's end; visual check of the right-aligned you header and md approval answers at narrow widths
Task A3: complete (commits acaeff1a..fa6247a2, review clean)
A4: dispatched (base fa6247a2, implementer a4bd47399c0ef8e8e)
A4: implemented 4664ea73 (related 52 files 341 tests; RED captured). Selection ratios real: Night 9.01, Day 9.08, HC 10.01 (plan 8.98/9.08/9.96; alpha 0x59 = 34.9 %); test asserts ≥ 7. Plan contradiction found: Exact values give white = brightWhite = text → 15 distinct, the test name says 16.
Ruling R11: white = mix(text, text-muted, 0.35) and brightWhite = text, so the palette has 16 distinct colours — the audit ("16 couleurs distinctes") and the owner's D8 choice ("16 couleurs dérivées des rôles", "ls --color gets its 16 levels back") bind over the plan's literal `white text`; the 35 % step mirrors the brights rule — cost if wrong: white reads slightly dimmer than text.
A4: fix round 1 dispatched (R11) before the review
B2: implemented e795cdb1 (761 tests; RED 11; bundle 245.4 KB). Concerns: filter in ProviderRows (its test lives there); filter starts on All when nothing is connected; phone layout puts chip/count under the switch (no meta); apply.test default → mixed; 3 AvailabilitySection tests adapted; appearance/model.ts 351
A4: fix round 1 (R11) 3d0f785d: white = mix(text, text-muted, 0.35), 16 distinct, white ≥ 4.5 on bg; review dispatched on fa6247a2..3d0f785d
Task B2: minor (deferred): no test mounts ProviderRows stack={true}; stacked w-24/w-28 cells space the count oddly; ThemeCards test asserts classes not layout
Carry to J1: first visit with no boot cache leaves data-density unset, so chat text jumps 14 → 15 px when `mixed` applies — boot-script should write the default (mixed) or tokens.css default to mixed; Line length has a visible effect only once lane A's A5 (max-w-measure on prose) is merged
Task B2: complete (commits 955b9c86..e795cdb1, review clean)
B3: dispatched (base e795cdb1, implementer a3757eeb7e4f40f6b)
Task A4: minor (deferred): font-family test cannot fail (sets --font-mono = --font-code); "no literal colour" check tests names only; mixHex/withAlpha assume #rrggbb; no bright-black vs white contrast test
Carry to B13 (derive.ts): custom-theme tokens must stay 6-digit hex, since the terminal palette's mixHex/withAlpha assume #rrggbb — assert it in derive.test
Task A4: complete (commits fa6247a2..3d0f785d, review clean)
A5: dispatched (base 3d0f785d, implementer ac3eb840e64e0179d)
A5: implemented e17e0baa (ui markdown+primitives 28 files 166, class-coverage/token-classes green; RED 3; related run skipped: lock queue)
Task A5: minor (deferred): first test's paragraph check lands on the heading p; no test for text-pretty on TextField/Switch hints; nested p in li/blockquote repeat the measure (harmless)
Task A5: complete (commits 3d0f785d..e17e0baa, review clean)
A6: dispatched (base e17e0baa, implementer abf340f7b95e248ac)
B3: implemented 7be8616d (related 117 files 857; RED 5; bundle 245.4). ShortcutsEditor h2 removed (F23); ThemeEditor modal title plain h3 (Heading takes no ref); AgentsSettings gap-s6 left
A5: implementer reports its late related run has 3 failing files (unidentified yet) — A5 completion on hold until named
A6: implemented 6765b4a1 (adr-index + docs-truth 15 green; tokens + literal-coverage green). 'replaces' not 'superseded' for decisions 27/28 (adr-index would demand a superseded status); DESIGN.md describes lane B before it merges → J1 re-read
B3: review: spec ❌, quality needs fixes: I1 gap-s6 left in NotificationsPanel.tsx:123, UsersSettings.tsx:39 (in scope); I2 AgentsSettings.tsx:39 (routes/settings, in scope) gap-s6, and its sibling headings (AgentsList, VmStatus, AgentTrash, SubagentsSettings in features/agents) still label-hud → mixed styles on Settings › Agents; 5 minors
Ruling R12: B3 fixes the three gap-s6 → gap-s5; the features/agents headings (AgentsList, VmStatus, AgentTrash, SubagentsSettings) belong to B5, whose scope already names features/agents — Settings › Agents mixes styles only between B3 and B5 on the lane branch — cost if wrong: none (B5 lands before J1).
Carry to B5: convert AgentsList, VmStatus, AgentTrash, SubagentsSettings headings (Settings › Agents); UsersSettings and the Account panels put an h3 right under the h1 (skipped level, F34 class) — make them h2; heading-style regex stops at the first `>` and ignores <Heading className="label-hud"> — widen it when the guard goes global
Task B3: minor (deferred): ThemeEditor modal title hand-copies the group style (Heading takes no ref — lane A item for later); FontsBlock/CustomThemes h4 under h2; headings.test asserts exact class strings and only levels[1]
B3: fix round 1 dispatched (I1, I2 gap part per R12)
Task A6: minor (deferred): §3.1 placeholder row gives Night ratios only; §9.2 ANSI paragraph one very long line; Wordmark JSDoc old wording; ADR 0086 doesn't repeat placeholder/selection ratios
Carry to J1: re-read DESIGN.md against merged lane B (mixed default + Line length B2; composer order D6 B6; Settings groups D4 + one width R9 B1; one orange home D7 B4; edit card B7; U+202F and backticks B12) and write the docs/agents/web.md glossary DESIGN.md §11 links to
Task A6: complete (commits e17e0baa..6765b4a1, review clean)
A5: the 3 failing files are the 7 known ApprovalCard h2 web tests (A3 carry to J1), not A5 — A5 stays complete
Lane A: complete (head 6765b4a1: A1 ba35ee7a, A2 acaeff1a, A3 fa6247a2, A4 4664ea73+3d0f785d, A5 e17e0baa, A6 6765b4a1)
B3: fix round 1/5 (I1 addressed; I2 gap part addressed, headings → B5 per R12; commits 7be8616d..cefc71a6, controller check (tiny fix); related 57 files 385)
Task B3: complete (commits e795cdb1..cefc71a6, review clean after R12)
B4: dispatched (base cefc71a6, implementer a3e42388cfbdd6b2a)
B4: implemented 29c08b6c (home-design 7; home+i18n+segmented 250; 3 old expectations updated; bundle 245.4). Concerns: the pink ActionRow text was the terminal-start FAILURE notice (the unavailable reason was already muted) — made muted per brief; Radix Segmented is role=group with radios, not radiogroup
Carry to B9a: ActionRow's terminal-start failure notice is a failure → InlineError (red, announce="action"), not muted
B4: review: spec ✅, quality needs fixes: I1 a box project's home with a stopped box has two primary fills (BoxFact.tsx:31 → BoxStart variant primary BoxStart.tsx:26, beside Launch ProjectHome.tsx:137); 4 minors
Ruling R13: on the home, BoxStart is secondary and Launch stays the one primary fill (D7 "one orange action"; DESIGN "at most one primary per view") — features/boxes is apps/web, lane B's — cost if wrong: starting a stopped box is one shade less prominent.
Task B4: minor (deferred): focus lost when Show all removes its own button; the radiogroup test title is wrong and radios().length > 0 is a tautology; weak not.toBe("What to do") check
B4: fix round 1 dispatched (I1 per R13)
B4: fix round 1/5 (I1 addressed per R13: BoxStart variant prop, home + stopped KnowledgeRow pass secondary; RED captured; radiogroup test renamed + exact count; commits 29c08b6c..fe199fb3, controller check; bundle 245.4)
Task B4: complete (commits cefc71a6..fe199fb3, review clean)
B5: dispatched (base fe199fb3, implementer a2242996c138e1cd7)
B5: implemented c6218538 (RED 23; related 1250; bundle 245.4). Concerns: 6 raw headings kept without label-hud (Heading has no attn tone, no className/tabIndex): AgentsList h2 (focus test needs tabIndex), RequestCards/ScriptTrust/TrustResources h3 (pink kept), ChangeList (flex); guard checks label-hud only; ClaudeToken h3 → h2
Carry to J1 (lane A item): Heading could take tabIndex/ref and an attn tone so the 6 raw headings + ThemeEditor title can use it
B5: review: spec ❌, quality needs fixes: I1 CodemodeBody.tsx:48,52,59,69 h4 className={label} (label = "label-hud text-muted") escapes the literal-string guard; I2 ShortcutsHelp.tsx:46 h3 "text-label text-muted" (same mono-label look) passes the guard; 6 minors
Task B5: minor (deferred): RequestCards uses text-attn-title vs text-attn on the other raw pink headings; many raw hand-copied h2–h4 remain outside the guard (GalleryItem, CompareColumn, AgentColumn, ProjectColumn, InboxPanel, SecretsList, policy files); no test proves the level choices; no fixture test of the scanner (single quotes, backticks); the Settings-folder test is redundant with the global one
B5: fix round 1 dispatched (I1, I2)
B5: fix round 1/5 (I1, I2 addressed: guard flags label-hud/text-label in h2–h4/Heading and bound className constants, scanner fixture tests, CodemodeBody + ShortcutsHelp → Heading card; RED captured; commits c6218538..ab671d8d, controller check; related 92 files 628)
Task B5: complete (commits fe199fb3..ab671d8d, review clean)
B6: dispatched (base ab671d8d, implementer aa092f15c04b14008)
B6: implemented c42173c1 (RED 5/6; sessions+i18n+segmented 858; bundle 245.4). Concerns: header policy-order assertion conditional (no stable policy hook); old Composer/race/handoff/SessionScreen tests rewritten (Steer/Follow up pick, Send sends); lazy-catalog counts 122 keys / 25 files
B6: review: spec ✅, quality needs fixes: I1 header-order test proves too little (conditional `if (policy)`, though data-session-policy exists SessionPolicy.tsx:179; title, policy, spacer outside the order selector); 5 minors
Ruling R14: the reviewer's minor "a second primary 'Send again' can appear next to Send while a send is pending" contradicts D6's "Send is the only primary" — fix it in B6's round (Send again secondary) — cost if wrong: one button shade.
Task B6: minor (deferred): model pills' position untested; save-on-select timing untested (choice saved on select, not on send); SessionMissing has an h2 and no h1; new FR copy untested
B6: fix round 1 dispatched (I1 + R14)
B6: fix round 1/5 (I1 + R14 addressed: unconditional policy assertion, full header sequence via compareDocumentPosition, data-header-spacer, Send again secondary; RED captured; commits c42173c1..e1b8217a, controller check; related 562)
Task B6: complete (commits ab671d8d..e1b8217a, review clean)
B7: dispatched (base e1b8217a, implementer a157fdb83feb434ef)
B7: implemented 2fcb648d (sessions+stores+i18n 1105; lazy-catalog fixed; bundle 245.4). Concerns: tool-summary.ts in stores/ (boundaries: stores can't import features or @pap/ui) so +N −M built inline (duplicates formatDiffCounts); read summary = path updated in transcript.tools test; running edit keeps the old view
B7: review: spec ✅, quality needs fixes: I1 read/write/edit summaries return args.path uncut (model-controlled, into the view-model and DOM; old summary cut at 200); I2 a failed/waiting edit shows the diff of a change never applied and hides the error (asEdit covers failed + waiting, drops the output body); 6 minors
Task B7: minor (deferred): no guard against the formatDiffCounts duplicate drifting; read/write drop offset/limit, argsTruncated always false; loading spinner says Running on a Done card with no 100 ms delay; EditDiff stale on prop change and refetch on reopen; edits [] gives +0 −0 and an empty box; weak diff assertion, no FR test
B7: fix round 1 dispatched (I1, I2)
B7: fix round 1/5 (I1, I2 addressed: cutPath 200 + "…" with argsTruncated, diff only for done edits; RED captured; commits 2fcb648d..d3e8124f, controller check)
Task B7: complete (commits e1b8217a..d3e8124f, review clean)
Carry to J1: build-output.int.test.ts row for EditDiff (lazy @pap/ui/code) runs at the join
B8: dispatched (base d3e8124f, implementer aebdb3181426e0d84)
B8: implemented 6698fc0d (related 3430/3431 then TabBar test updated to 'a Working'; RED 8/9; bundle 245.4). Concerns: chip min-w-0 shrink on a wrapper div (Button takes no className); vocabulary strings left to B11; Minimap turns square with transparent left border
B8: review: spec ❌ (cross-lane), quality needs fixes: I-1 MobileShell.tsx ~115 wrapper div cannot make the project chip shrink — Button is shrink-0 whitespace-nowrap (packages/ui Button.tsx:10) and takes no className, so a long name still overflows at 320 px; 6 minors; vocabulary strings correctly left to B11
Ruling R15: I-1 needs a packages/ui change (lane A, closed); per the plan ("a need in the other lane's files goes to the ledger for J1") J1 gives Button a way to shrink and truncate (e.g. a `truncate` prop: min-w-0 shrink + truncated label) and MobileShell uses it, with the J16 layout journey proving no overflow at 320 — cost if wrong: the 320 px header overflows until J1.
Task B8: minor (deferred): title hidden under 400 px leaves icons against the chip (no spacer); AppShell.names test passed before; skip-link/palette tests check classes only; current-states packs 3 components in one it; main#pane-host may show a default outline after the skip jump
Task B8: complete (commits d3e8124f..6698fc0d, 1 carried to J1 per R15)
B9a: dispatched (base 6698fc0d, implementer ab9d01f0b4badc6b9)
B9a: implemented 8277beab (RED: 50 stray alerts + 5 red statuses; related 387 files 3228; bundle 246.3 KB). Allowlist 3 entries (Transcript data-failure, SessionScreen dismissable notice, TerminalPane close question); SessionScreen error split feed=status / command=alert; ArchiveDialog branchKept pink status kept (not a failure)
B9a: review: spec ✅ (1 gap), quality needs fixes: I1 ChangesPane.tsx:167 "refresh failed" still pink role=status text-attn (answers the Refresh click → InlineError action); I2 the guard misses InlineError tone="attn" on a failure and pink failure statuses (checks only literal role="alert" lines and role=status+text-err on one line); 5 minors; 24 sites sampled, classification right
Task B9a: minor (deferred): SessionScreen server-push notice is a bare role=alert without icon (weak allowlist reason); allowlist per file lets new alerts in those files pass; TerminalPane close question role=alert not a failure; ReviewFileDiff comment limit pink status; branchKept pink status unguarded
B9a: fix round 1 dispatched (I1, I2)
B9a: fix round 1/5 (I1, I2 addressed: ChangesPane + ReviewFileDiff → InlineError action; guard catches pink failure statuses/alerts and InlineError attn with a pink allowlist (ArchiveDialog, LaneScreen branchKept); RED 5 hits; commits 8277beab..465f02e1, controller check; related 62 files 393)
Task B9a: complete (commits 6698fc0d..465f02e1, review clean)
B9b: dispatched (base 465f02e1, implementer acfef31b3ff03b1f0)
B9b: brief regenerated (the plan's heading 'Task B9a / B9b / B9c' made brief.sh miss it); B9b and B9c briefs = the shared B9 section
B9b: implemented 0b758400 (RED 3; related 207 files 1719; bundle 246.3). Judgment calls: ProviderUsage + InviteScreen retry/refused = action; AuditLog (incl. Load older) = background; pink allowlist +ProviderFields, ClaudeToken, AutomationForm cap, NotificationsPanel, InviteScreen, TokenCreate, GithubSettings; DevicesList revoke confirmation in ALERT_ALLOWLIST; RulesByProject more count pink → muted
B9b: review: spec ❌, quality needs fixes: I1 four load failures announced action instead of background (RulesByProject.tsx:98, TrustDialog.tsx:85, ModelList.tsx:310, ProviderForm.tsx:125); I2 NotificationsPanel.tsx:199 draws every non-ok status pink (off, needs HTTPS, no push API, unsupported, read-only → muted; only "allow notifications" waits for the person) + keysReset :208; 9 minors
Task B9b: minor (deferred): ProviderForm.tsx:174-180 and ProviderDetail.tsx:104 classification; pink guard skips allowlisted files whole and misses a pink child inside a role=status div; save test asserts length > 0; InviteScreen retry from the mount check should be background; AuditLog "Load older" failure should be action (needs failedOlder); ProviderFields clear-text/key-held and AutomationForm cap should be muted (5 more in the review)
B9b: fix round 1 dispatched (I1, I2 + the three cheap pink→muted minors in the same files)
B9b: fix round 1/5 (I1, I2 + 3 minors addressed: 4 loads → background, NotificationsPanel status + keysReset muted (the allow state included: the button carries the ask), ProviderFields + AutomationForm cap muted, allowlist trimmed (staleness check); RED captured; commits 0b758400..2cf330e2, controller check; related 161 files 1302)
Task B9b: complete (commits 465f02e1..2cf330e2, review clean)
B9c: dispatched (base 2cf330e2, implementer a987d9c77ff580b60)
B9c: implemented 51e151bf (RED guard 3/5 + 2 tests; related 130 files 951; guard global; bundle 246.3). Calls: gone/unreadable/paused/VM-unusable muted; BoxStart role=status text-err → InlineError background; pink allowlist + AgentForm step-up note, gallery specimen; e2e role=alert locators unchecked → J1
B9c: review: spec ✅ (BoxStart deviation), quality needs fixes: I1 BoxStart.tsx:45 failed Start answers this component's click → action (kept background only to keep old tests); I2 SecretsList.tsx:129 unreadable vault is a real failure → red background InlineError; I3 VmStatus.tsx:33 unusable (run sudo pap vm setup) → red background InlineError; 5 minors; guard scope global confirmed
Task B9c: minor (deferred): over-red states changedElsewhere, egress full note, NewAgentDialog late; hand-drawn status check one line only; pink tag scan stops at first `>`
B9c: fix round 1 dispatched (I1–I3)
B9c: fix round 1/5 (I1–I3 addressed: BoxStart action, SecretsList unreadable + VmStatus unusable red background; RED 8; commits 51e151bf..f7e56e4d, controller check; related 88 files 596)
Task B9c: complete (commits 2cf330e2..f7e56e4d, review clean)
B10: dispatched (base f7e56e4d, implementer a2b72e413275d52e0)
B10: implemented a1ebf290 (RED 7/8; related 3474; bundle 246.3). Concerns: empty-states renders only DevicesList + TokensPanel (4 at catalog level); MobileShell.agents test uses real timers vi.waitFor on the 100 ms delay; ellipsis guard covers *.loading + sessions.transcript.thinking only
B10: review: spec ❌, quality needs fixes: I1 empty-states.test renders 2 of 6 (AgentColumn, FireJournal, SecretsList, CustomThemes only at catalog level); I2 MobileShell.agents.test waits the 100 ms on a real clock (no-sleeps rule, flaky) → fake timers as drawers.test; 3 minors
Task B10: minor (deferred): ellipsis guard regex single-line only; settings.github.loading splits the health group in the catalog
B10: fix round 1 dispatched (I1, I2)
B10: fix round 1/5 (I1, I2 addressed: six empty states rendered with exact copy (key-removal RED 6), fake-timer loading delay; commits a1ebf290..51aa3bc7, controller check)
Task B10: complete (commits f7e56e4d..51aa3bc7, review clean)
B11: dispatched (base 51aa3bc7, implementer af153f6c01bf11725)
B11: implemented 329d403a (RED 3; related 413 files 3444; bundle 247.0 KB). ~35 tests updated to the new error copy; commands.pane.split FR still « Diviser le volet » (commands.ts:139, outside B11) → B12
Carry to B12: commands.pane.split FR « Diviser le volet » → « Scinder le volet » (one vocabulary)
Task B11: minor (deferred): worker_failed's "Send again" also shows after a failed Stop/Clear/paste; inert "Split pane" fixtures in CommandPalette.test and rank.test; substring assertions in ModelBar/CommitBar tests
Carry to B12: FR shell.pane.separator still « panneaux » → volet vocabulary
Task B11: complete (commits 51aa3bc7..329d403a, review clean)
B12: dispatched (base 329d403a, implementer a9eb602e8989dadc5)
B12: implemented 23f4f544 (web unit 5526; bundle 247.1). Concerns: code-copy render test in src/ (boundaries); backticks dropped from 8 keys, only agentsPhone.noVmPurpose in CODE_COPY_KEYS; appearance sample lost inline code; copy outside ACRONYMS: AA → 'Meets AA', HMAC → 'HMAC signature', health severities Err/Att/Mut; e2e uppercase/French ' :' locators → J1
B12: review: spec ❌, quality needs fixes: I1 backticks dropped from keys that render through InlineError (boxes.error.sandbox_unavailable / vm_bundle_stale / command_failed via use-box-action + ProjectSettings; error.sandbox_unavailable / vm_bundle_stale via errorKey + AgentScreenParts) → CODE_COPY_KEYS + backticks restored EN/FR; I2 FR values in English: settings.theme.aa "Meets AA", automation.editor.webhook.authHmac "HMAC signature" → add AA and HMAC to ACRONYMS, restore bare values; 4 minors; frenchSpacing idempotent; FR vocabulary carries done
Task B12: minor (deferred): health severity aria-labels Err/Att/Mut read as abbreviations; guards find catalogs by En/Fr export suffix; code-copy word list hand-written
B12: fix round 1 dispatched (I1, I2 + check laneCommit.pr.hint.gh render path)
B12: fix round 1/5 (I1, I2 addressed: 5 InlineError keys in CODE_COPY_KEYS with backticks restored EN/FR, AA + HMAC in ACRONYMS, values restored; laneCommit.pr.hint.gh renders in a plain <p>, stays plain; RED 2; commits 23f4f544..52261b70, controller check)
Task B12: complete (commits 329d403a..52261b70, review clean)
B13: dispatched (base 52261b70, implementer ab6cd1930c125f6b6)
B13: implemented 40972edc (RED glyph/dim/star/derive; 902 green; bundle 247.2). Concerns: 6-digit check on opaque tokens only (tint/line/diff/grid carry alpha by design); StarButton raw <button size-6> (IconButton lacks filled/aria-pressed); trigger-icon.ts in lib/ (boundaries)
Carry to J1: e2e locators matching glyph text (✓ 2, ●2, tests ✓, trusted ✓) now icons or words
Task B13: minor (deferred): StarButton duplicates IconButton classes, no Tooltip; star test doesn't assert aria-pressed/coarse class; derive focus ring checked on surface-2 only; dim-tone web test has no allowlist (forbids all dim); glyph scan skips only whole-line comments; "1 checks failed" grammar pinned; StatusPanel "?" glyph for unknown source
Task B13: complete (commits 52261b70..40972edc, review clean)
Lane B: complete (head 40972edc)
J1a: dispatched (carries file j1-carries.md, base e88b7c2b, implementer a9544a515b86b7b8c)
J1a: implemented — merges 318068b5 (A) + edf12215 (B), clean; fixes d4cd17a8 (approval h2 tests), f7b33f30 (Button truncate, R15), fe2adb65 (first paint mixed), 269ae342 (Heading tabIndex/ref/attn), 7e568ad3 (Reasoning key guard test; key was stable), 536d3059 (Reasoning streaming optional). web unit 637 files 5527, ui 62 files 449, build-output.int 52; bundle 247.4 KB. Concerns: RequestCards + ChangeList stay raw h3 (need className); AgentsList heading shows a focus ring on keyboard focus now
J1a: review dispatched (a0cc2c8503a026240); J1b: dispatched (base 536d3059, implementer a0897b793d55370a9: J16 + e2e fixes + full e2e)
J1a: review: spec ✅ (item 5 partial, allowed), quality approved; 5 minors (brittle shrink-0 string tests; Heading attn via .replace("text-fg"); tone attn on section untested; focus:outline-none left in AgentSettingsView.tsx:74 and AuthFrame.tsx:29 (pre-existing, §7.4); Button truncate wraps string children only)
Task J1a: complete (commits e88b7c2b..536d3059, review clean)
J1b: implemented 80690509 (J16 + J07 fix). Full e2e: 33 passed, 4 skipped, 3 failed (J10 ×2, J16 webkit 91 > 90) in 4m18s; J16 skipped off chromium, ~8 s. Found: (1) first Tab skips the skip link in Chromium: TabBar scrollIntoView moves the focus start point (J16 first-Tab test is fixme); (2) J10 fails on main too: /settings/models shows Appearance.
Controller check of (2): useShellEffects runs outside the RoleContext.Provider, but a traced unit run shows it reads role=owner; /auth/status returns role; sections.role unit tests (owner deep links, added uncommitted on main) pass — root cause unknown, investigation delegated to the J1b implementer (repro in the container)
J1b: fix round 1 dispatched (TabBar scroll fix + un-fixme the first-Tab test; J10 root cause)
J1b: round 1 e848a23f (TabBar scrolls by scrollLeft only when needed, first-Tab step real in J16, chromium green; shell unit 373). J10 root cause (container trace): useShellEffects reads useRole() above AppShell's RoleContext provider → default member → owner deep links to models/mcp/skills/users replaced with Appearance (and restrict(member) rewrites the owner's saved tabs).
Controller: confirmed — testing/dom.ts mount() wraps every element in an owner provider, which hid it in unit tests. Fixed on MAIN 13141c65 (role passed as a param; renderShell puts the default member above the shell like main.tsx; 4 owner deep-link tests RED then green; routes+workspace 91 files 553). Preview rebuilt + restarted, pushed.
Found (accident): my changed-file list came out empty and vitest ran the whole unit project once (2119 files: 2 failed — compose-agents-vm-status relay readiness, passes alone (load flake); scripts/build-npm-package.test.ts "real built package starts a command" fails alone and fails without the fix too: pre-existing on main) → later lot
Join: main merged again d9f52db1 (owner deep-link fix); typecheck + shell/settings 85 files 448 green
J1b: review dispatched (a74ab832214cc6385); J1c: screenshot pass dispatched (aa5de8ce5036462e4, pap-design-audit, uncommitted, detector fetch v0.1.17 sha-checked); J1d: docs + final e2e dispatched (a335c182b9f1eb5d0, base d9f52db1)
J1b: review: spec ✅ (notes), quality approved; I1 j16 skips the whole journey on WebKit (only the char-count step needs it); I2 90-char bound is font-dependent → assert width ≤ 72ch via a width:72ch probe + per-engine char ceiling (chromium 90, webkit 95); I3 no clean full e2e on the join head yet (J1d runs it); 7 minors
Ruling R16: J16 keeps all its steps on WebKit; the measure step asserts the paragraph's width ≤ a 72ch probe and a per-engine ceiling (chromium 90, webkit 95 characters) — 72ch is a width, WebKit's narrower glyphs fit 91 — cost if wrong: a Safari line of 91–95 characters passes.
Task J1b: minor (deferred): TabBar left-cut-off branch untested; tab wider than the strip hides its start; 320 session page never sees the long name; scrollWidth misses overflow-x hidden; Day ring step relies on Shift+focus(); TabBar comment should name J16; five steps in one test
Task J1b: complete (commits 536d3059..e848a23f; I1/I2 per R16 carried to J1d before its final e2e)
J1d: 6d329279 (J16 R16: width ≤ 72ch probe + chromium 90 / webkit 95, all steps on both engines, 182 lines) + d2fe480f (web.md glossary/groups/width/Line length/InlineError/Heading/copyText/guard table/deep links/limits/bundle; e2e.md J16; decision 132 "merge sha: pending"; DESIGN.md re-read: no drift). Doc tests 27/27. FULL E2E green: 36 passed, 2 skipped (J13 webkit), 0 failed, 3:29 (chromium 18, webkit 16, phones 1+1; J10 passes; J16 7.9 s / 8.3 s). Bundle 247.4 KB.
Task J1: complete (J1a e88b7c2b..536d3059, J1b ..e848a23f, J1d ..d2fe480f; J1c screenshot pass running, uncommitted)
J2: Opus final review dispatched on 13141c65562dd17db8163bb7ef9acb6870ba225d..d2fe480f (a4f74a9e4864fb19e)
J1c: screenshot pass (uncommitted, pap-design-audit): 11/13 pass. FAIL 1: agent prose at 1440 measures ≤ 97 characters (median 94) with the audit's seeded paragraph, expected ≤ 90 — 72ch in Manrope fits more than 90 (J16's paragraph passes ≤ 90). FAIL 2: Minimap current turn shows no agent rule / text-fg: cn() concatenates "border-transparent text-muted" with "border-agent text-fg" and the base classes win (B8 bug; its test checked class names). Detector binary ran (sha256 = sidecar = audit), source scan: 0 undersized-ui-text (v2: 366), side-tab 2 in side-tab.test.ts + 1 built CSS; in-page script not run (would need a second fetch).
Ruling R17: the 72ch measure stays (the owner's D3 value); the 97-character reading goes to the owner at the end (tighten to ~66ch to reach ≤ 90, or keep 72ch) — cost if wrong: lines ~95 characters until the owner decides.
Carry to the final fix wave: Minimap current state classes must not concatenate with the base (choose one set per state), with a rendered-style test.
J1c also: Settings › MCP shows "Loading servers..." (three dots; key not named *.loading, so the ellipsis guard missed it) → final fix wave (and widen the guard to every value ending in "..."); home's first Tab lands on Launch because the launch field holds focus on load — accepted (the person is already in the content; the skip link is first elsewhere, J16); Appearance/MCP/Models keep a 1136 px header and wrapper with controls at 768 (split sections, R9 scope) — accepted
J2: final review (Opus): needs fixes, 0 C, 5 I (I1 Minimap current state cn() base classes win; I2 pink failures the guard misses: CrashBanner:44, SendBar:29, CodemodePane:52, LaneHeader:52, PrPanel:57 + AlwaysRules:108, AuditRow:149 pink but not to answer; I3 error.sandbox_unavailable / vm_bundle_stale backticks raw in toasts (use-purge-trash:21, surface-terminal:77, SessionMenu:50) and a Banner title (ArchivedShelf:102); I4 Switch coarse hit boxes overlap in tight lists (ProviderRows ~24 px rows); I5 docs/research/design-impeccable-after.md missing), 5 pre-merge minors, 18 other minors
Ruling R18: I3 is fixed by rendering Toast messages and Banner titles that are strings through CodeText (packages/ui), keeping code styling wherever a CODE_COPY_KEYS value lands — cost if wrong: a toast showing a literal backtick pair as code.
Ruling R19: launch.placeholderAll gets a period after "PR" (the plan's literal text ran two sentences together) — cost if wrong: none.
J2: final fix wave dispatched (Sonnet a2cc2f968d42f895f, base d2fe480f, list in final-fix-list.md)
J2: final fix wave d2fe480f..d50151e2 (1970f347 I1–I3, 7e3a3f26 I4, e54243f7 items 6+13, cdce3811 7–9, 379c4a0a 10/11/14, 9dccafba I5 + DESIGN §12, d50151e2 J03 helper for the plural keys). Gate clean; build-output.int 52; doc tests 27; e2e j16/j15/j02/j03 green on both engines; bundle 247.4. Item 10: the MCP value already had U+2026 (the "..." in the ledger was a misreading) — guard widened to every value. Not named, left: TriggerEditor.tsx:58 "unreadable" and GithubHomeEntry.tsx:29 "failed" read muted → later lot
J2: final re-review: all 14 ADDRESSED, no new C/I; carry TriggerEditor.tsx:58 + GithubHomeEntry.tsx:29 muted failures → later lot
J2: squash a0c0b2c4 on main (tree = feat/design-impeccable d50151e2); build, budgets 247.4 KB, smoke ok; preview restarted (usual 3 warnings), doctor 22 ok, no warn; pushed. No pap vm setup (nothing under packages/pi-host, packages/contracts or apps/daemon changed).
Task J2: complete (merge a0c0b2c4)
