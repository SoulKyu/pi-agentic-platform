# J2 final review: design pass after the impeccable audit

Branch `feat/design-impeccable`, join worktree `/home/ubuntu/Workspace/soulkyu/pap-design`, range `13141c65..d2fe480f` (471 files). Reviewer: Opus, read-only (decision 131, R5).

## Verdict

**Needs fixes.** 0 Critical, 5 Important, 18 Minor. All five Important items are small, local fixes (one to five lines each, plus a test or a doc page). The lot does what it set out to do: labels are 11 px, prose has a 72ch measure, errors go through `InlineError`, Settings has its groups and its single width, the terminal has 16 colours, there is no sideways scroll at 320 px, and the measured contrast failures pass. The five items are seams that no task review could see: one is visible only in a real browser (the CSS cascade), one sits in a guard's blind spot, one needs the code paths followed through, one comes from coarse-pointer geometry, and one is a missing J1 deliverable.

## What was checked

- The packages/ui diff in full, the apps/web diff (source hunks in full, test hunks skimmed), and DESIGN.md, ADR 0086, `docs/agents/web.md`, `e2e.md` and decisions 131/132.
- The code on the head, for every seam named in the dispatch.
- J1c's uncommitted screenshot-pass output, `shots-after/measure.jsonl` (149 records), read as evidence of the rendered page.
- Ran, under the flock, `--project unit`: inline-error, heading-style, catalog-guards, glyph-icons, both dim-tone tests, code-copy, current-states, TabBar, settings-groups, tokens, terminal-theme. 12 files, 73 tests, all green.

## Review Focus 1, 2, 5

**Focus 1 (errors read as errors): mostly met, with residues (I2, I3, and the B9a triage item).** Every live-region failure that the B9 migration touched is now `InlineError`: red, with IconWarning and its words, `alert` for an action and `status` for background. The guard catches stray `role="alert"` and pink live regions. The failures it cannot see are the ones drawn pink *without* a role of their own, or pink inside another live region (I2). Two more sit in allowlisted files: the session notice (alert, no icon) and the transcript failure block (no icon).

**Focus 2 (contrast): met for every pair the audit measured.**
- Day ring on surface-2: measured on the page as rgb(194,65,12) on rgb(238,235,228), 4.35:1. The unit tests cover all three themes.
- Placeholders are `text-muted` at opacity 1 (≥ 4.5:1 in the three presets).
- Terminal: the selection is agent at 0x59 alpha, and text on it is ≥ 7:1 (measured rgb(69,58,103) in Night). The 16 colours are distinct, and Day black is #6b645a (5.55:1).
- The `ext` chip is in `attn-title`.
- Custom themes: `derive.ts` moves the ring to 3:1 on bg, surface and surface-2, and `text-muted` to 4.5:1 on bg and surface. The tokens stay 6-digit hex.
- The one current-state contrast failure the audit measured (the minimap, 1.08:1) is **not** fixed in the browser (I1).

**Focus 5 (bundle and lazy code): met, not re-measured.**
- The ledger and J1d report 247.4 KB, under 249.
- The terminal palette (`ansi-palette.ts`) is reached only from `@pap/ui/terminal`, and markdown stays behind `Markdown.tsx`'s lazy import.
- `EditDiff` statically imports `@pap/ui/code`, but only its thin wrappers (`DiffView` lazy-loads `DiffPane`, and `languageFor` lazy-loads its languages). They live in the session chunk, which is lazy itself.

## Important

### I1. The minimap's current turn still has no agent rule and no fg text in a real browser (F09 not fixed for the minimap)
- `apps/web/src/features/sessions/Minimap.tsx:60-61, 84`. The base class list carries `border-l-2 border-transparent … text-muted`, and the current turn adds `border-agent bg-surface text-fg` through `cn`. `cn` (`packages/ui/src/cn.ts`) only joins strings: there is no tailwind-merge. Two utilities of one property both apply, and the stylesheet order decides which wins.
- Evidence: `shots-after/measure.jsonl` lines 30 and 171, minimap at 1440, the element with `aria-current="true"`: `"border": "… left 2px rgba(0, 0, 0, 0)"` and `"color": "rgb(156, 149, 181)"` (text-muted). Only `bg-surface` applied, which is the 1.08:1 state the audit measured (the audit already noted "texte identique (muted)", so the text conflict predates the lot). B8 added the border to the same pattern.
- `current-states.test.tsx:96-99` only checks that `className` contains `border-agent` (happy-dom has no cascade), which is why it passed. B8's deferred minor "tests check classes only" is what hid this.
- Fix: exclusive branches, `current ? "border-agent bg-surface text-fg" : "border-transparent text-muted can-hover:hover:text-fg"`. Then make the test assert that the current button has no `border-transparent` and no `text-muted` (or add one J16 computed-style step).
- BottomNav, AgentRail, the Settings nav and the tree rows already use exclusive branches. The shots confirm the bottom nav's agent bar.

### I2. Failures still drawn pink, without the icon, outside the guard's reach
- `apps/web/src/features/sessions/CrashBanner.tsx:44`: a failed Retry (reopen, the person's own click) shows `<p className="text-attn">` inside the crash Banner. Pink, no icon.
- `apps/web/src/features/lanes/SendBar.tsx:29`: "The comments could not be sent." is a pink `<span>` inside a muted `role="status"`. It answers the Send click, so it is announced politely, and it is pink. This is the "pink child of a status" gap B9b noted, but nobody fixed this site.
- `apps/web/src/features/mcp/CodemodePane.tsx:52`: "The global settings.json could not be read…" is a read failure, pink. B9c ruled the same case (SecretsList "unreadable") red background.
- `apps/web/src/features/lanes/LaneHeader.tsx:52`, `PrPanel.tsx:57`: `lanes.pr.error.failed` ("status unavailable") and `not_found` show in `text-attn`.
- Not failures, but pink with nothing to answer: `features/sessions/AlwaysRules.tsx:108` (`rules.more`; B9b made the twin line in RulesByProject muted) and `features/policy/AuditRow.tsx:149` (`audit.gap`).
- Fix:
  - CrashBanner: `InlineError announce="action"`.
  - SendBar: a red `InlineError announce="action"` beside the status, not inside it.
  - CodemodePane: `InlineError announce="background"`.
  - PR badge: `text-err` plus `Icon IconWarning` for `failed` and `not_found`; `not_signed_in` and `forge_missing` may stay pink, since the person must act.
  - `rules.more` and `audit.gap`: muted.
  - Optionally a cheap guard: flag `text-attn` on any element whose `t()` key matches `/failed|error|unreadable/`.

### I3. Two CODE_COPY_KEYS reach plain-text render paths, so backticks still show raw (F55)
- `apps/web/src/i18n/code-copy.ts:10-11` keeps the backticks in the *generic* `error.sandbox_unavailable` and `error.vm_bundle_stale`, which reach the UI through `errorKey()` from about 50 call sites.
- `code-copy.test.tsx` only renders each key in its named component. The app also sends them to `toast()`, whose `Radix.Description` renders `entry.message` as text (`packages/ui/src/primitives/Toast.tsx:79`):
  - `features/agents/use-purge-trash.ts:21`. `trash-purge.ts:28` throws `sandbox_unavailable`, so on a host without a VM, purging an agent's trash toasts "… needs KVM and \`sudo pap vm setup\`." with the backticks.
  - `routes/shell/surface-terminal.ts:77`, `features/projects/SessionMenu.tsx:50`.
- They also reach a Banner `title` (`features/projects/ArchivedShelf.tsx:102`; Banner runs CodeText on string children only).
- The catalog guard's claim ("each renders through its component with code and no backtick") does not hold for these two keys.
- Fix: render string messages through `CodeText` in `Toast.tsx:79`, and string titles in `Banner.tsx` (one line each, no bundle cost). Or drop the backticks from the two generic `error.*` keys and keep them only in `boxes.error.*` and `agentsPhone.noVmPurpose`. Also pass `tone: "error"` in `use-purge-trash.ts:21`.

### I4. Under a coarse pointer, Switch hit boxes now overlap in tight lists, so a tap can toggle the next switch
- `packages/ui/src/primitives/Switch.tsx:39`: R8 makes the hit box 44 × 44 with `before:` insets and keeps the row at its natural height. Before the lot, `pointer-coarse:min-h-11` grew the track and so spaced the rows.
- In Settings › Models › Availability, the model switches of a provider sit in `<ul className="flex flex-col gap-s1">` (`features/models/availability/ProviderRows.tsx:31`), each a label-only Switch. Each row is about 19.5 px (13 px at line-height 1.5), so the pitch is about 24 px.
- Each 44 px box overlaps its neighbours by about 20 px. The later sibling paints on top, so the box of switch N+1 covers the bottom 6 px of switch N's visible track: a tap there toggles the model below. This is S2's m6 ("cannot verify"); it follows from the CSS, but it was not measured in a browser.
- Fix: `pointer-coarse:min-h-11` on the Switch's outer `[data-slot="switch"]` row. The track stays 32 × 16 (F56) and the rows are 44 px apart, so the boxes cannot overlap. Test it the way `controls.test.tsx` computes the box.

### I5. The after-values were never recorded, and decision 132 points to a file that does not exist
- `docs/research/decisions-log.md` (decision 132) says "After-values: see `docs/research/design-impeccable-after.md`". `docs/agents/web.md` ("Known limits") also refers to "the after page of docs/research". That file is not on the branch. The plan's J1 step "Record the after-values against this table" is not done.
- The measurements exist (`shots-after/measure.jsonl`). Writing them up would have shown I1 (the minimap) and m2 (94 to 97 characters a line against the expected ≤ 90).
- Fix: write the after page from `measure.jsonl` against the J1 table (with the 320 px header, Day ring, terminal, palette, missing session and MCP loading rows), or change decision 132 to say where the values are. Do this before the merge records the pointer for good.

## Deferred minors: fix before merge

1. **B3, `FontsBlock` and `CustomThemes` h4 under the Appearance h2** (`features/appearance/FontsBlock.tsx:63,84`, `CustomThemes.tsx:186`). B3 turned the `AppearanceSection` titles into h2, which created an h2 → h4 skip on a page the detector scans: the same skipped-heading rule as F34. Set `level={3}`.
2. **B9a, the session screen's error notice** (`features/sessions/SessionScreen.tsx:225-229`). It is `role="alert"` for a server-pushed notice (a background event) and has no warning icon. Give it `role="status"` and `IconWarning` (Focus 1, DESIGN §2).
3. **B4, Show all removes its own button** (`features/home/RecentWork.tsx:113`). Keyboard focus falls to `body`. Move it to the filter's All radio, or to the list.
4. **B7, EditDiff's loading spinner** (`features/sessions/EditDiff.tsx:62`). It says "Running" on a Done card and shows at once. Use `DeferredFallback` and a loading word (the lot's own §7.3 rule).
5. **B8, `current-states.test.tsx` checks classes only.** This is what hid I1. Strengthen it as part of I1.

Optional, cheap:
- B13: "1 checks failed" (use `plural` for the sr-only text).
- J1a: `focus:outline-none` at `AgentSettingsView.tsx:74` and `AuthFrame.tsx:29`. DESIGN §7.4 says "never removed", and `Heading tabIndex` already shows the pattern with `focus-ring`.
- B8: `main#pane-host` gets the UA outline after the skip jump. Add `focus-ring`; do not remove the outline.

Every other "minor (deferred)", "Carry" and "Found" line can wait for a later lot.

## Minor (18)

- **m1. Copy: `launch.placeholderAll` runs two sentences together** (`i18n/catalog/launch.ts:11, 29-30`). EN reads "…then open a PR Launch asks which project.", and FR "…ouvrez une PR Lancer demande quel projet.". It follows the plan's literal, but it reads as broken English and French. Add a period after "PR" and "une PR".
- **m2. 72ch gives 94 (median) to 97 (max) characters a line.** Measured: Manrope 15 px, block 648 px (`measure.jsonl` "prose" at 1440 in Night, Day and HC). The J1 table expected ≤ 90; J16's chromium ceiling of 90 passes only for its test sentence. This is an owner call: keep 72ch (D3 as written) or lower the measure to about 66ch to reach the ≤ 90 the audit's 65–75-character intent implies.
- **m3. Settings h2 come in two sizes.**
  - Section style (16/700): Appearance, Shortcuts, MCP, Models, Notifications, Automation.
  - Group style (13/600): Agents (`AgentsList.tsx:22`, `VmStatus.tsx:27`, `AgentTrash.tsx:41`, `SubagentsSettings.tsx:22`), `ClaudeToken.tsx:81`, Account (`DevicesList.tsx:123`, `PasskeysList.tsx:130`, `TokensPanel.tsx:113`), `UsersSettings.tsx:41`.
  - The plan's B3 rule says a section under the h1 is `level 2 variant section`. This is a seam between B3 and B5.
- **m4. Settings › Approvals.**
  - Its h3 come straight after the h1, a skipped level (`policy/ApprovalsPanel.tsx:36-89`, `RulesByProject.tsx:96`, `AuditLog.tsx:19`). `features/policy` was in neither B3's nor B5's heading scope.
  - `ApprovalsPanel.tsx:33` and `agents/AgentSettingsTab.tsx:50` keep `gap-s6`, outside the gap-s6 guard's folders.
- **m5. Heading levels invert at a seam.** `ChildApprovals.tsx:22` is an h3 ("From …"), and the `DialogList` cards below it are at the default h2. On agent threads, `AgentHeader`'s h2 and the approval-card h2 are siblings. Let `DialogList` take a `level` and pass 3 where it is nested.
- **m6. An unnamed session has no h1.** `SessionScreen.tsx:146`; shots: `"h1": null`. Its approval cards' h2 then stand alone; `SessionMissing` has no h1 either. Pre-existing.
- **m7. The transcript failure block has no warning icon** (`Transcript.tsx:226-234`; allowlisted, red, with a title and next step). DESIGN §2 now says "with the warning icon".
- **m8. Issue lists left the live region.** `KeybindingsJson.tsx` Outcome, `ThemeImport.tsx` ImportErrors, `CloseLosersDialog.tsx` and `ArchiveDialog.tsx`'s script log now sit outside the alert, so a screen reader hears only the first line.
- **m9. Fence labels still shout.** `catalog/github.ts:75,177` ("UNTRUSTED · github log"; the FR value is the English one) and `lane-new.ts:14,84`. The catalog guard refuses only values with no lowercase letter.
- **m10. `settings-width.test.ts` misses folders and caps.** It scans seven feature folders and leaves out `policy` (Approvals), `auth` (Account), `commands/editor` (Shortcuts) and `routes/settings`. It also ignores `max-w-sm/md/lg` and `max-w-5xl` and up. Nothing is capped today.
- **m11. `inline-error.test.ts` "no failure is drawn as muted or status-red text by hand"** checks only one-line `role="status"` plus `text-err`. A multi-line tag passes, and a muted failure cannot be detected at all; the test name overclaims.
- **m12. DESIGN.md contradicts itself on errors.** §12 still says "Live regions announce … errors politely", against §2's new rule that the result of your own action is an alert.
- **m13. Two lines of `docs/agents/web.md` are wrong.** "The lazy `Reasoning` still takes a `streaming` prop it does not read" is stale: the prop is optional and no caller passes it. "`Heading`: the one heading primitive" overclaims: raw h2 and h3 remain in Account, Users, Approvals, Notifications and Automation.
- **m14. `ApprovalCard.tsx:141` names a local tag variable `Heading`**, the same name as the new primitive (confusing). Rename it `Title`.
- **m15. The `build-output.markers.ts` row for EditDiff proves the wrong thing.** It shows that the session-tools catalog strings stay out of the initial assets, not that DiffPane's code does.
- **m16. Data-loading lines are not deferred.** Only `LazyBoundary` defers. On a client navigation to MCP, the shots show "Loading…" at +128 ms, then "Loading servers…" until +1186 ms: still two lines for one wait (the F28 wording) whenever the chunk takes more than 100 ms.
- **m17. `FileViewer`'s markdown preview inherits the 72ch cap and the Line length setting** (`render.tsx` is shared), while DESIGN §9.2 speaks of agent prose. It is harmless; say so in §13, or scope it to agent messages.
- **m18. `RequestCards.tsx:43` draws "expired" pink in `text-label`, and `PermissionsSheet.tsx:55-60` draws the trifecta lines pink.** Both are defensible as attention states, but they sit in the same blind spot as I2. Re-check them when the guard widens.

## Seams

- **S2 primitives:**
  - `InlineError` is used consistently: string children everywhere, so `CodeText` applies.
  - `DeferredFallback` is used only in `lazy.tsx` (m16).
  - `EmptyState level` is used once (TokensPanel); EmptyStates under an h2 elsewhere (Inbox, Health) stay h2.
  - `Segmented` `labelHidden` matches its allowlist of seven files.
  - `Switch meta` holds ProviderRows' fixed cells; see I4 for the hit area.
- **ApprovalCard h2 against lane B's pages:** correct under a named session's h1. See m5 for ChildApprovals and agent threads, and m6 for unnamed sessions.
- **Button `truncate`:** ProjectSwitcher passes a pre-truncated span plus an icon, so the "strings only" limit does not bite. The 320 px shots show no overflow (`scrollWidth` 320 on home, session, Settings, Tasks and the trigger editor). The phone header measures 44 / 0 (the `contents` wrapper) / 0 (hidden title) / 44 / 44 / 44.
- **Heading's new props:** `tabIndex` adds `focus-ring`; `ref` is a React 19 prop; `tone="attn"` works through `.replace("text-fg")` (brittle; known minor). ThemeEditor's title and the AgentsList focus target use them correctly.
- **CODE_COPY_KEYS render paths:** see I3.
- **DESIGN.md against the code:** §3, §4, §5, §7.3, §7.4, §9.1, §9.2, §10, §11, §13 and §14 agree with the code. The exceptions: §2's "with the warning icon" (I2, m7, triage 2) and §12 (m12). The §13.1 example theme is applied.

## Coverage

Every Coverage row is implemented, with these exceptions:
- F09: the minimap is broken (I1). The rail and the bottom nav are fixed; the bottom-nav agent bar was measured.
- F03 and F21: residues (I2, triage 2).
- F55: toast and title paths (I3).
- F56: the hit area overlaps in tight lists (I4).
- F24: the fence labels (m9).
- F02: the measure is applied, but at 94–97 characters (m2).
- F35 and F36: deferred as the plan says.
- F22: the optional line was taken (the terminal reads `--font-code`).

## Guards

- **headings:** the multi-line tag scan and the bound-constant check are real. Loopholes: a `className` from `cn(...)` stored in a constant, an imported constant, h5 and h6, and raw headings in the wrong level or size (m3, m4).
- **dim tone:** the web scan has no allowlist, so all dim is refused: strict and good. The ui scan exempts `disabled:` by a 9-character look-behind, which is fine.
- **alerts and pink:**
  - The `role="alert"` scan is line-based but sufficient (prettier keeps `role="alert"` on one line).
  - Allowlists pass whole files.
  - The pink live-region scan stops at the first `>`, so an `=>` before `className` hides it.
  - It cannot see pink without a role, or a pink child of a status (I2).
  - `aria-live="assertive"` would bypass it; none exists today.
- **catalogs:**
  - Shouting is refused only when a value has no lowercase letter at all (m9).
  - The French spacing check runs on the translated value: good.
  - The backtick rule holds in the catalog, not on the render paths (I3).
- **glyphs:** whole-line comments are skipped. ✓, ● and the rest in a JSX comment `{/* ✓ */}` would trip it (a safe failure).
- **Settings width:** misses folders and caps (m10).
- **Segmented labels:** an exact file list. Good.
- **side-tab and summary-focus:** fine.
- **Class-only DOM tests miss cascade conflicts** (I1). Add a "no idle class on the current element" assertion, or one computed-style e2e step.

## M14

- Member hiding holds:
  - `sectionsFor(role)` filters `OWNER_SECTIONS` (models, mcp, skills, users).
  - Groups with nothing left disappear; a member's This pap shows Health only.
  - A deep link opens Appearance (`sectionFor`).
- The owner deep-link fix from main (13141c65, merged at d9f52db1) is on the branch: `useShellEffects` takes `role` from AppShell's props, and `renderShell` puts the default member above the shell.
- `settings-groups.test.tsx` covers the member case. It does not assert that You and Work are present (known minor).

## Accessibility

- **Names:**
  - Segmented is `aria-labelledby` its label.
  - The running tab says "Working" (shots: `"accessibleText": "work Working"`).
  - The CI checks have sr-only words.
  - The star button has `aria-pressed` and a label.
- **Focus order:** the skip link comes first (J16 Chromium and WebKit); TabBar no longer moves the focus start point. Focus is lost after Show all (triage 3).
- **Live regions:** background loads are status and actions are alerts, with the exceptions in I2, triage 2, m8 and m12.
- **44 px coarse targets:** StarButton, IconButton, Segmented items, the bottom nav and approval answers (44 at 320 and 390, measured) are fine. Switch: see I4.

## EN and FR copy

The plan's exact-copy list was checked against the catalogs key by key:
- the skip link, the groups and Line length;
- the provider filter, the missing session, the model-failure line and the edit card;
- the font example, Recent work, GitHub loading and the eight errors;
- the six empty states, the vocabulary and the glyph words.

All are exact. The only defect is m1 (a plan literal); the FR fence copy is m9.

## Not verified

- **Bundle and lazy entries:** `pnpm budgets` and `build-output.int.test.ts` were not run by me. The 247.4 KB is J1d's figure, and `build-output.int` last ran at J1a (52 green), before J1b and J1d (TabBar, docs).
- **No browser:**
  - I1 rests on J1c's `measure.jsonl`, not on a run of mine.
  - I4 is derived from the CSS and the row geometry.
  - The screenshot PNGs were not viewed, so the 11 px label fit in Badge, Avatar and the Wordmark (A1's deferred item) is not checked.
- **Detector:** no after-run of the impeccable detector was found in `shots-after/` (no undersized-ui-text count). The 11 px labels are measured in the "type" records only.
- **e2e:** not run (by rule). J1d's report: 36 passed, 2 skipped, 0 failed.
- **Screen readers:** announcement behaviour (status regions inserted with their text, alerts inside a Banner alert) was not tested.
- **FR layouts:** French values were checked in the catalogs, not rendered at narrow widths.

## Re-review of the fix wave

# Final fix wave re-review (d2fe480f..d50151e2)

Verdicts (all ADDRESSED):
1. I1 ADDRESSED: Minimap.tsx buttonClass(isCurrent) exclusive branches; rail AgentRail.tsx:40 and BottomNav.tsx:55 already exclusive; current-states.test.tsx:77,104-105,114-115 assert idle classes absent (rail only checks border-transparent; fine, the rail idle set is that one class).
2. I2 ADDRESSED: CrashBanner/SendBar/CodemodePane -> InlineError, LaneHeader/PrPanel -> PrError; inline-error.test.ts new guard matches text-attn content against failed|error|unreadable|not_found|unavailable, RED capture lists all five sites; AlwaysRules/AuditRow muted.
3. I3 ADDRESSED: Toast.tsx:81 and Banner.tsx title via CodeText; Toast.test.tsx and display.test.tsx assert <code> and no backtick; use-purge-trash gets tone error.
4. I4 ADDRESSED: Switch.tsx row has pointer-coarse:min-h-11, track stays h-4 w-8; controls.test.tsx asserts the class (class-level only, happy-dom has no layout).
5. I5 ADDRESSED: docs/research/design-impeccable-after.md exists, web.md links it.
6. 6 ADDRESSED: FontsBlock/CustomThemes level 3; headings.test.tsx.
7. 7 ADDRESSED: SessionScreen.tsx role=status + IconWarning; allowlist entry removed.
8. 8 ADDRESSED: RecentWork.tsx refocusFilter ref + effect focuses checked radio, only after Show all (no focus theft on other filter changes).
9. 9 ADDRESSED: EditDiff DeferredFallback + loading label; ToolItemCard.edit.test.tsx.
10. 10 ADDRESSED (accepted): no "..." in the catalog; loading-copy.test.ts refuses any value ending in three ASCII dots, any key; \s* in the regex spans multi-line entries. Only catches trailing dots, as the item asked.
11. 11 ADDRESSED: launch.ts period after PR EN/FR.
12. 12 ADDRESSED: DESIGN.md section 12 aligned.
13. 13 ADDRESSED: Approvals headings h2.
14. 14 ADDRESSED: lanes.ts pr.checks.{passed,failed,pending}.{one,other} EN/FR; CheckCount uses plural(); no other caller of the old keys (J03 helper fixed in d50151e2).

New Critical/Important: none.
Notes (minor): Switch 44 px proof is class-level only; TriggerEditor:58 and GithubHomeEntry:29 muted failures carried to a later lot (reported by implementer).
