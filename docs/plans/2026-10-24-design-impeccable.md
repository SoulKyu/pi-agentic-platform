# Design pass after the impeccable audit (Night Control v1.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** This plan turns the 58 active findings of the v2 design audit into work: HUD labels at 11 px and a prose measure; red errors through one primitive; 3:1 and 4.5:1 wherever the audit measured a failure; one Settings layout, a readable edit card and a 16-colour terminal; phones at 320 px without horizontal scroll; guard tests so the drift does not come back. The audit's « à refuser » list stays refused.

**Starts after M14 merges** (7ea23ea0, decision 130), from that main. M14 touches the same web files: the Settings sections (`users`, owner-only sections hidden for members), the Rail and the mobile bar (role chip), the GitHub settings, the token dialog and the invitation page. B1 is designed with the `users` section and the member hiding.

**Architecture:**
- **S1** adds the shared tokens: the prose measure, the settings column, a narrow breakpoint, and the icon names.
- **S2** adds the shared primitives: `InlineError`, `DeferredFallback`, `CodeText`, `Heading`; EmptyState `level`, Segmented's visible label, Switch `meta`, Icon `filled`; a unique-names test helper.
- **Lane A (`packages/ui`, DESIGN.md):** type and spacing tokens, contrast and browser surfaces, primitive behaviour, the terminal palette, the prose measure, DESIGN.md and ADR 0086.
- **Lane B (`apps/web`):** Settings frame, contents and headings; the home and headings elsewhere; the session screen and the edit card; shell, keyboard and phone; the InlineError migration in three parts; empty and loading states; copy and catalog guards; glyphs, the dim tone and custom-theme contrast.
- **Join:** J1 covers the visual check (the screenshot pass re-run, plus one committed layout journey), the docs and the decisions log. J2 is the final review and the merge.

**Tech Stack:** TypeScript (erasable), React 19 + React Compiler, Tailwind 4 (`@theme inline`), Radix, lucide-react, xterm.js, CodeMirror merge (`@pap/ui/code`), vitest + happy-dom, Playwright 1.63 (ADR 0071).

**Spec:**
- The audit: `docs/research/design-audit-impeccable-v2.html`, published with its screenshots at https://claude.ai/artifact/PBgpv4hGBgcjeo91snrMvX. Its text version is the planning scratchpad's `impeccable-v2/text.txt`: copy it into the SDD workspace as `audit.txt`. A finding's "Correctif v2" supersedes its v1 fix.
- DESIGN.md (spec B). Decision 33 says changes to it go through an ADR; here that is ADR 0086.
- ADR 0012 and decisions 27 and 28, which D2, D3 and A2 amend.

## Owner questions

**Answered (owner, 2026-10-25, decision 131):** every recommendation, D1 (a) · D2 (a) · D3 (b) · D4 (b) · D5 (b) · D6 (a) · D7 (a) · D8 (a), and « go ». The form with its before/after examples: `docs/research/design-impeccable-decisions.html`. Every line a decision settles carries the tag `(Dn, owner, 2026-10-25: the recommendation)`.

- **D1 · HUD label size (F01).** Labels sit at 10.5 px and 0.12em; the detector counts 366 texts under the 11 px floor.
  - Options: (a) 11 px, 0.08em, mono capitals kept · (b) 11 px, 0.1em · (c) keep 10.5 px at 0.12em.
  - **Recommendation (a):** one token clears the floor, and the tighter tracking keeps French labels as wide as today.
  - Changes: A1, A6.
- **D2 · Default density (F14).** Compact (decision 27) sets prose at 14 px / 1.55.
  - Options: (a) `mixed` (compact UI, prose 15 px / 1.65) · (b) keep `compact` · (c) `comfortable`.
  - **Recommendation (a):** the transcript is the most-read surface, and mixed changes only the prose. A device that saved a density keeps it.
  - Changes: B2, A6.
- **D3 · Agent prose measure (F02).** Decision 28 kept full width ("pi-web rejected a 72ch cap"); lines reach 202 characters at 1440 px.
  - Options: (a) 72ch always; code, tables, tool cards and diffs stay full width · (b) 72ch by default, plus a per-device Line length choice (Limited or Full width) in Appearance › Reading · (c) no cap.
  - **Recommendation (b):** it fixes the default and keeps decision 28 one switch away.
  - Changes: S1, A5, B2, A6.
- **D4 · Settings grouping (F17).** 14 links, M14's Users included, sit under "Personal".
  - Options:
    - (a) the audit's groups: You · Agents and tools · Platform (Users in Platform);
    - (b) You (Appearance, Shortcuts, Language, Notifications, Account) · Work (Agents, Approvals, Automation, GitHub) · This pap (Models, MCP, Skills, Users, Health);
    - (c) one list, renamed "Settings".
  - **Recommendation (b):** it follows M14's line between what each user owns and what the install shares. A member's "This pap" shows Health only.
  - Changes: B1, A6.
- **D5 · Section titles and field labels (F15).** Titles and field labels share one style today.
  - Options: (a) titles in Manrope (16/700 sections, 13/600 groups), field labels in sentence case Manrope 12 px muted · (b) titles as in (a), field labels stay HUD mono capitals at the D1 size · (c) titles stay HUD in `fg`.
  - **Recommendation (b):** the titles carry the hierarchy fix, and the labels keep the identity of DESIGN §1. The Uppercase labels switch already gives sentence case.
  - Changes: S2, B3, B4, B5, A6.
- **D6 · Composer during a run (F12).**
  - Options: (a) Stop first, one Steer | Follow up Segmented, one primary Send · (b) Stop first, two secondary buttons with the remembered one `aria-pressed` · (c) only move Stop first.
  - **Recommendation (a):** one choice, one action, and the urgent action first.
  - Changes: B6.
- **D7 · One orange action on the home (F49).**
  - Options: (a) Enable OKF secondary, and the Recent work filter becomes a Segmented · (b) Enable OKF secondary, the filter stays ghost buttons with `aria-pressed` · (c) keep both.
  - **Recommendation (a):** orange means your main action (§2), and a filter is a state.
  - Changes: B4.
- **D8 · Terminal palette (F05).**
  - Options: (a) role-derived 16 colours (black → `text-muted`, a distinct cyan, brights 35 % toward `text`, `minimumContrastRatio: 4.5`, an agent selection at 35 %) · (b) a conventional xterm palette per theme, outside the roles · (c) keep the role map and fix only black and the selection.
  - **Recommendation (a):** it keeps §9.2's role idea and the theme editor's reach, and gives `ls --color` back its 16 levels.
  - Changes: A4, A6.

## Global Constraints

**Repo rules (AGENTS.md, CI-enforced):**
- At most 400 lines per `.ts`/`.tsx`/`.js` file, tests included; `tokens.test.ts` caps `tokens.css` and `utilities.css` at 400 too.
- Tokens only: no raw colours, no `[…]` values, and `@pap/ui` primitives are restyled only inside `packages/ui`.
- The only ESLint directive allowed is `eslint-disable-next-line <rule> -- <reason>`.
- Erasable TS; relative imports keep `.ts`.
- Class lists must compile (`scripts/class-coverage.ts`), and no hard-coded `uppercase` (`label-case.test.ts`).
- Tests never touch `~/.pi/agent` or `~/.pap`, and use no sleeps: UI timers run under `vi.useFakeTimers()`.

**After M14:**
- Before each task, re-read the web files M14 changed: `features/workspace/model.ts` (`users`, `OWNER_SECTIONS`), `routes/settings/sections.tsx`, `SettingsScreen.tsx`, `palette-items.ts`, `item-path.ts`, `Rail.tsx`, `MobileListsMenu.tsx`, `AppShell.tsx`, `RootLayout.tsx`, the GitHub settings, `FontsBlock.tsx`, `TokenCreate.tsx`, `AgentPackages.tsx`, `features/users/*`, `features/auth/InviteScreen.tsx`, `i18n/catalog/users.ts`.
- M14's behaviour stays: owner sections stay hidden for members, a member's deep link to one opens Appearance, and the role chip and M14's strings stay (B12 changes only their case).

**Lanes and ownership:**
- S1 and S2 touch both packages before the split.
- Lane A owns `packages/ui/**`, `DESIGN.md`, `docs/adr/0086-*`, `docs/adr/README.md`, and one header line of ADR 0012.
- Lane B owns `apps/web/**` and `scripts/e2e/catalog*.ts`.
- J1 owns the merges, `scripts/e2e/j16-layout.e2e.ts`, journey locator fixes, `docs/agents/*.md` and the decisions log.
- A need in the other lane's files goes to the ledger for J1.

**Files near the cap (re-count after M14):**
- `features/appearance/model.ts` 345, `tokens.css` 328, `tokens.test.ts` 296, `NotificationsPanel.tsx` 274, `SessionScreen.tsx` 272, `Transcript.tsx` 271, `i18n/index.ts` 261, `row-view.ts` 238, `ApprovalCard.tsx` 236.
- New logic goes in new files: `tool-summary.ts`, `EditDiff.tsx`, `SessionMissing.tsx`, `SettingsToolbar.tsx`, `fr-spacing.ts`, `code-copy.ts`, `ansi-palette.ts`, `testing/names.ts`.

**Exact values:**

| What | Value |
|---|---|
| `label-hud`, `--text-label`, `--tracking-label` | 0.6875rem (11 px), weight 600, 0.08em, `var(--label-transform)` (D1, owner, 2026-10-25: the recommendation) |
| Default density | `mixed` (D2, owner, 2026-10-25: the recommendation) |
| Prose measure | `:root { --prose-measure: 72ch }`; `[data-prose="full"] { --prose-measure: none }`; `@theme` `--spacing-measure: var(--prose-measure)` → `max-w-measure`; device default `limited` (D3, owner, 2026-10-25: the recommendation) |
| Settings column | `--spacing-settings: 48rem` → `max-w-settings` |
| Narrow phone | `--breakpoint-xs: 25rem` → `max-xs:` (below 400 px) |
| Comfortable `--space-6` | `48px` (compact and mixed stay `32px`) |
| Rhythm | 4 px under a title (`gap-s1`), groups `gap-s4`, sections `gap-s5` (24 px compact/mixed, 32 px comfortable; the audit's "32 px" is the comfortable value) |
| `Heading` variants | section `text-h2 text-fg` (16/700) · group `text-ui font-semibold text-fg` (13/600) · card `label-hud` in `text-muted` or `text-agent` (D5, owner, 2026-10-25: the recommendation) |
| Day `--focus-ring` | `#c2410c`: 4.92 on bg, 5.18 on surface, 4.35 on surface-2 (was `#ea580c`, 2.99 on surface-2) |
| Placeholders | `::placeholder { color: var(--text-muted); opacity: 1 }`. Ratio on bg / surface: Night 6.68 / 6.19, Day 5.55 / 5.84, HC 13.62 / 12.24 |
| Browser surfaces | `::selection { background-color: color-mix(in srgb, var(--agent) 30%, transparent) }`; `html { caret-color: var(--you); scrollbar-color: var(--border-strong) transparent }`. Ruling: `--you`, not `--you-fill`, because Day's fill is 2.26:1 on white |
| Chip `ext` | `border-dashed border-attn text-attn-title` (5.96:1 on the approval card, Night) |
| Approval answers | `size="md"` (`h-control`) at every width |
| Switch | the track stays `h-4 w-8`; under `pointer: coarse` a `before:` box at `-inset-x-1.5 -inset-y-3.5` makes a 44 × 44 hit area; the visible box does not grow |
| `InlineError` | `<p data-slot="inline-error">`, `flex items-start gap-s1 text-ui text-err`, `IconWarning` 14 px `aria-hidden`. `tone="attn"` → `text-attn`. `announce="action"` → `role="alert"`, `"background"` → `role="status"` |
| `DeferredFallback` | renders nothing for 100 ms, then its children |
| Terminal (D8, owner, 2026-10-25: the recommendation) | black `text-muted` · red `err` · green `ok` · yellow `you` · blue `agent` · magenta `attn` · cyan = mix(agent, ok, 0.5) · white `text`. Each bright = mix(base, text, 0.35); brightWhite = `text`. `minimumContrastRatio: 4.5`. Selection = agent + alpha `59` (35 %); text on it reaches 8.98 / 9.08 / 9.96 (Night / Day / HC) |
| Current states | rail: 1 px `border-agent` frame + `bg-surface-2` · minimap: `border-l-2 border-agent text-fg`, square corners · bottom nav: `border-t-2 border-agent text-fg` |
| Palette field | the placeholder repeats its `aria-label` text; `focus:border-agent` draws the bottom rule (6.47:1 on surface) |
| Skip link | the first focusable element of `DesktopShell`: `sr-only focus:not-sr-only`, `href="#pane-host"`; `main#pane-host` gets `tabIndex={-1}` |
| Composer during a run (D6, owner, 2026-10-25: the recommendation) | Stop (secondary) · model pills · Steer \| Follow up (Segmented, `labelHidden`) · Send (primary) · Attach files |
| Settings groups (D4, owner, 2026-10-25: the recommendation) | `you`: appearance, shortcuts, language, notifications, account · `work`: agents, approvals, automation, github · `install`: models, mcp, skills, users, health |
| Settings layout | `column` (body `max-w-settings`) for every section; `split` for appearance, models and mcp, whose forms cap themselves at `max-w-settings` |
| Edit summary | `{path} · +{added} −{removed}` (`formatDiffCounts`), counted after trimming common leading and trailing lines; at most 8 edits drawn |
| Loading lines | end with U+2026 "…", never `...` |
| French spacing | U+202F before `? ! : ; »` and after `«`, applied when a French catalog registers |

**DESIGN.md applies to every change** (owner rule; same block as B2 and M14):
- Tokens and primitives only. Buttons are mono uppercase through `label-hud`; catalog values are sentence case. At most one primary (the you fill) per view; Cancel is never danger.
- Colour = role: red when something broke, pink only when the person must answer, neutral for "unavailable". Chips carry a word; errors have three parts.
- Feedback timing follows §7.3 (nothing under 100 ms). Live regions are polite, except for the result of your last action. Targets are 44 px under a coarse pointer. EN and FR, with « vous » in FR.

**Exact copy (EN / FR; values in sentence case, `label-hud` uppercases them):**
- **Skip link.** `shell.skip`: "Skip to content" / « Aller au contenu ».
- **Settings groups (D4, owner, 2026-10-25: the recommendation).** `settings.nav.group.you` "You" / « Vous » · `.work` "Work" / « Travail » · `.install` "This pap" / « Ce pap ». `settings.nav.personal` is removed.
- **Line length (D3, owner, 2026-10-25: the recommendation).** `settings.appearance.prose.label` "Line length" / « Longueur des lignes » · `.limited` "Limited" / « Limitée » · `.full` "Full width" / « Pleine largeur ».
- **Provider filter.** `settingsAvailability.show.label` "Providers shown" / « Fournisseurs affichés » · `.connected` "Connected" / « Connectés » · `.all` "All" / « Tous ».
- **Missing session.** `sessions.missing.title`: "This session no longer exists" / « Cette session n'existe plus ». `sessions.missing.purpose`: "It was deleted, or this link comes from another pap. Your other sessions are intact." / « Elle a été supprimée, ou ce lien vient d'un autre pap. Vos autres sessions sont intactes. » Buttons: `sessions.missing.back` "Back to the project" / « Retour au projet » · `sessions.missing.search` "Search sessions" / « Chercher dans les sessions ».
- **Model failure.** `session.failure.next`: "The transcript is intact. Send your message again to retry, or choose another model." / « La transcription est intacte. Renvoyez votre message pour réessayer, ou choisissez un autre modèle. »
- **Edit card.** `sessions.tool.edit.diff` "The edit's changes" / « Les modifications de l'édition » · `.same` "This edit changed nothing." / « Cette édition n'a rien changé. » · `.more` "{count} more edits not shown" / « {count} autres éditions non affichées ».
- **Launch.** `launch.placeholder`: "Fix the flaky login test, then open a PR" / « Corrigez le test de connexion instable, puis ouvrez une PR ». `launch.placeholderAll`: the same sentence + " Launch asks which project." / + « Lancer demande quel projet. ».
- **Font example.** `settings.appearance.fonts.placeholder`: "IBM Plex Sans" (both languages).
- **Recent work.** `home.recent.emptyFiltered` "Nothing matches this filter." / « Rien ne correspond à ce filtre. » · `home.recent.showAll` "Show all" / « Tout afficher ».
- **GitHub loading.** `settings.github.loading`: "Loading the GitHub settings…" / « Chargement des réglages GitHub… »
- **Errors (three parts, §11; each replaces today's value):**
  - `error.bad_request`: "pap refused this request: a value is missing or out of range. Nothing was changed. Check the fields and try again." / « pap a refusé cette demande : une valeur manque ou sort des limites. Rien n'a été modifié. Vérifiez les champs et réessayez. »
  - `error.not_found`: "This item no longer exists: it was deleted, or the link is wrong. Nothing else was changed. Pick it again from its list." / « Cet élément n'existe plus : il a été supprimé, ou le lien est faux. Rien d'autre n'a été modifié. Choisissez-le à nouveau dans sa liste. »
  - `error.conflict`: "This changed in the meantime, or it already exists. Your version was not saved. Reload, then make your change again." / « Cet élément a changé entre-temps, ou il existe déjà. Votre version n'a pas été enregistrée. Rechargez, puis refaites votre modification. »
  - `error.capacity`: "pap is at capacity: every worker slot is in use. Nothing was started. Try again when a session finishes, or stop one." / « pap est à pleine capacité : tous les emplacements de worker sont pris. Rien n'a été lancé. Réessayez quand une session se termine, ou arrêtez-en une. »
  - `error.worker_failed`: "The session process stopped. The transcript is intact. Send again to restart it." / « Le processus de la session s'est arrêté. La transcription est intacte. Renvoyez votre message pour le relancer. »
  - `error.read_only`: "A newer pap wrote this database, so this one opened it read-only. Nothing was changed. Update pap to use it again." / « Un pap plus récent a écrit cette base de données : celui-ci l'a ouverte en lecture seule. Rien n'a été modifié. Mettez pap à jour pour l'utiliser à nouveau. »
  - `error.internal`: "pap hit an unexpected error. The action may not have completed: check its result, then try again. If it repeats, run pap doctor." / « pap a rencontré une erreur inattendue. L'action n'a peut-être pas abouti : vérifiez son résultat, puis réessayez. Si elle se répète, lancez pap doctor. »
    - Ruling: this reworks the audit's example, because "Nothing was changed" would overclaim for an unknown error (§11).
  - `error.offline`: "pap is unreachable: this page cannot reach the daemon. Your drafts stay on this device. Check that pap is running, then retry." / « pap est injoignable : cette page n'atteint pas le daemon. Vos brouillons restent sur cet appareil. Vérifiez que pap tourne, puis réessayez. »
- **Empty states (first use; a sentence of purpose):**
  - `automation.column.empty`: "No tasks yet. A trigger adds one here each time it fires." / « Aucune tâche pour l'instant. Un déclencheur en ajoute une ici à chaque tir. »
  - `automation.journal.empty`: "No fires yet. Each fire or skip of this trigger is logged here." / « Aucun tir pour l'instant. Chaque tir ou saut de ce déclencheur est noté ici. »
  - `access.tokens.empty`: "No tokens yet. A token lets a script or another machine call pap with the permissions you choose." / « Aucun jeton pour l'instant. Un jeton permet à un script ou à une autre machine d'appeler pap avec les permissions que vous choisissez. »
  - `agentSafety.secrets.empty`: "No secret saved yet. A saved secret reaches the agent's shell as an environment variable." / « Aucun secret enregistré pour l'instant. Un secret enregistré arrive dans le shell de l'agent comme variable d'environnement. »
  - `notifications.devices.empty`: "No device is registered yet. Turn on notifications in this browser or on your phone to get an alert when an agent needs you." / « Aucun appareil n'est enregistré pour l'instant. Activez les notifications dans ce navigateur ou sur votre téléphone pour recevoir une alerte quand un agent a besoin de vous. »
  - `settings.theme.empty`: "No custom themes yet. Start one from a preset to change the role colours." / « Aucun thème personnalisé pour l'instant. Partez d'un préréglage pour changer les couleurs des rôles. »
- **Vocabulary.** `shell.tabs.split` "Split the pane" / « Scinder le volet » · `shell.tabs.unsplit` "Close the split" / « Fermer la scission »; `lanes.pane.split` and `lanes.pane.unsplit` take the same values; `shell.pane.choose` in FR becomes « Afficher dans ce volet ».
- **Glyphs as words.** `compare.tests.passed` "tests passed" / « tests réussis » · `compare.tests.failed` "tests failed (exit {code})" / « tests en échec (code {code}) » · `compare.tests.failedNoCode` "tests failed" / « tests en échec » · `automation.dry.trusted` "{cwd} (trusted)" / « {cwd} (dossier de confiance) ».

**Bundle:**
- Today: 244.7 of 250 KB gzip initial. Expected eager growth is about 3 KB: S2 primitives about 1 KB, icons on eager screens about 0.6 KB, base-catalog error copy about 0.7 KB, French spacing about 0.1 KB. The markdown, the session screen, the terminal, `@pap/ui/code` and the Settings panels are lazy.
- Every S and B task runs `pnpm budgets` and writes the KB in the ledger. Above 248.5 KB, stop and ask; the budget is never raised without the owner.

**Gate per task:**
- `pnpm exec eslint --max-warnings=0 <changed>`, `pnpm format:check`, `pnpm typecheck`, `pnpm knip`; `pnpm budgets` for S and B tasks.
- `flock /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/heavy-gate.lock pnpm exec vitest related --run --project unit --maxWorkers=3 <changed .ts/.tsx>`, plus the named tests. Export `PATH=/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/bin:$PATH`.
- Never a full suite. Never e2e in a task gate: e2e runs at the join and the final review (ADR 0071).

**Commits:** Conventional Commits, no AI attribution.

**Model table:**

| Task | Implementer | Task review |
|---|---|---|
| S1, S2, A1–A6, B1–B13, J1 | Sonnet | Sonnet |
| J2 | n/a | Opus final review of the branch (as for B2 and M14; the owner confirms) |

No Haiku, and no Opus task review.

## Review Focus

1. **Errors read as errors.** An inline failure is red, with the warning icon and words. Pink appears only when the person must answer. A background failure is a polite status. Tests: S2 `InlineError is red with the warning icon and its words by default`; B9c `no role="alert" in apps/web outside InlineError, Banner and the allowlist, and none on pink text`.
2. **Every contrast failure the audit measured passes in the three themes and in custom themes:** the Day ring on surface-2, placeholders, the terminal selection, ANSI black. Tests: A2 `the focus ring reaches 3:1 on bg, surface and surface-2 in every theme`; A4 `the selection keeps text at 7:1 in every theme`; B13 `custom themes keep the focus ring at 3:1 on surface-2 and placeholders at 4.5:1`.
3. **The guards stop the drift from coming back.** Tests: A2 and B13 `the dim tone colours only idle avatars and disabled controls`; B5 `no h2, h3 or h4 in apps/web carries label-hud`; B12 `no catalog value is all capitals except acronyms`, `no French value keeps a plain space before ? ! : ; »`, `a backtick appears only in CODE_COPY_KEYS, rendered as code`.
4. **Settings keeps M14's roles right after the regrouping.** Test: B1 `a member sees You, Work and This pap with Health only, and a deep link to an owner section opens Appearance`.
5. **The initial bundle stays at or under 249 KB, and lazy-only code stays lazy** (the edit diff, the terminal palette, the markdown). Tests: J1 `pnpm budgets` and `build-output.int.test.ts`; B7 `the edit diff loads from the lazy @pap/ui/code entry`.

---

## Shared (before the lanes split)

### Task S1: tokens, CSS hooks and icon names

**Files:**
- `packages/ui/src/tokens.css`:
  - `@theme inline` gains `--spacing-measure`, `--spacing-settings` and `--breakpoint-xs`;
  - `:root` gains `--prose-measure`;
  - a new `[data-prose="full"]` rule.
- `packages/ui/src/icons.ts` and `index.ts` export the new names: `IconSchedule` (Timer), `IconWebhook` (Webhook), `IconFeed` (Rss), `IconManual` (Play), `IconStar` (Star), `IconFailed` (X), `IconCancelled` (CircleSlash), `IconOpenItems` (Layers).
- Tests: `tokens.test.ts`, `scripts/token-classes.test.ts`, new `packages/ui/src/icons.test.ts`.

**Interfaces (produces):** `max-w-measure`, `max-w-settings`, the `max-xs:` variant, `data-prose="full"`, and the eight icon names.

- [ ] **Step 1: Failing tests:**
  - `tokens.test.ts`: `the prose measure is 72ch on :root and none under data-prose="full"`.
  - `token-classes.test.ts`: `max-w-measure reads --spacing-measure`; `max-w-settings is 48rem`; `max-xs:hidden applies under 25rem`.
  - `icons.test.ts`: `the new names export lucide's Timer, Webhook, Rss, Play, Star, X, CircleSlash and Layers`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(ui): prose measure, settings column, narrow breakpoint and icon names`.

### Task S2: shared primitives and the names helper

**Files:**
- New in `packages/ui/src/primitives/`: `InlineError.tsx`, `DeferredFallback.tsx`, `CodeText.tsx`, `Heading.tsx`.
- Edits: `EmptyState.tsx`, `Banner.tsx`, `Segmented.tsx`, `Switch.tsx`, `Icon.tsx`, and their exports in `index.ts`.
- New `apps/web/src/testing/names.ts`, and gallery entries in `apps/web/src/gallery/sections/*`.
- Fix any web test that the visible Segmented label breaks (duplicate text queries).

**Interfaces (produces):**
- `InlineError({ tone?: "err" | "attn"; announce: "action" | "background"; id?: string; children: ReactNode })`.
  - `announce` is required, so each call site decides.
  - A string child goes through `CodeText`.
- `DeferredFallback({ delayMs?: number /* 100 */; children: ReactNode })`.
- `CodeText({ text: string })`.
  - Backticked runs render as `<code data-slot="code-text" class="font-mono text-code">`.
  - Nothing else is parsed, and markup stays text.
- `Heading({ level: 2 | 3 | 4; variant: "section" | "group" | "card"; tone?: "muted" | "agent"; id?: string; children })`, with the classes from Exact values (D5, owner, 2026-10-25: the recommendation).
- `EmptyState` gains `level?: 2 | 3` (default 2) and renders `purpose` through `CodeText`; `Banner` renders string children through `CodeText`.
- `Segmented` gains `labelHidden?: boolean`.
  - The label shows above the items in the field-label style.
  - The radiogroup is `aria-labelledby` that label.
  - `labelHidden` makes the label `sr-only`.
- `Switch` gains `meta?: ReactNode`, between the label column and the track. `Icon` gains `filled?: boolean` (`fill="currentColor"`).
- `duplicateNames(root: ParentNode): string[]` returns each accessible name shared by two headings, two landmarks (nav, main, labelled sections), or two buttons of one group.
  - A name is the `aria-labelledby` text, else `aria-label`, else the text content.

- [ ] **Step 1: Failing tests:**
  - `InlineError.test.tsx`: `is red with the warning icon and its words by default`; `tone attn is pink`; `announce action is an alert, background a polite status`.
  - `DeferredFallback.test.tsx`: `renders nothing before 100 ms and its children after`; `an unmount before 100 ms leaves no timer`.
  - `CodeText.test.tsx`: `renders backticked runs as code and any markup as text`.
  - `Heading.test.tsx`: `renders the asked level with the section, group and card classes`.
  - `display.test.tsx`: `EmptyState level 3 renders an h3`; `a purpose with backticks shows code and no backtick`; `Icon filled fills with currentColor`.
  - `controls.test.tsx`: `Segmented shows its label and names the radiogroup by it; labelHidden keeps it for screen readers only`; `Switch meta sits between the label and the track`.
  - `apps/web/src/testing/names.test.ts`: `finds two headings, two landmarks or two buttons of a group with one name`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(ui): InlineError, DeferredFallback, CodeText, Heading and labelled Segmented`. Both lanes start from this commit.

---

## Lane A: `packages/ui` and DESIGN.md

### Task A1: type and spacing tokens (F01, F47, F39 size)

**Files:**
- `packages/ui/src/utilities.css`: `label-hud` at 0.6875rem and 0.08em.
- `tokens.css`: `--text-label: 0.6875rem`, `--tracking-label: 0.08em`; comfortable `--space-6: 48px`.
- Tests: `utilities.test.ts`, `tokens.test.ts`.

**Interfaces:** produces the D1 label (D1, owner, 2026-10-25: the recommendation). The Wordmark tagline uses `label-hud` and follows it.

- [ ] **Step 1: Failing tests:**
  - `utilities.test.ts`: `label-hud is 11 px, weight 600, 0.08em, on the label-transform variable`.
  - `tokens.test.ts`: `text-label is 11 px`; `comfortable steps are 6 · 10 · 16 · 24 · 32 · 48` (the density test, updated).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(ui): HUD labels at 11 px, a sixth comfortable step`.

### Task A2: contrast and browser surfaces (F07, F58, F31, F06, F04 ui part)

**Files:**
- `tokens.css`: the Day `--focus-ring`, in `[data-theme="day"]` and in the no-JS fallback. `presets.ts`: the Day `focus-ring`.
- `utilities.css`: `::placeholder`, `::selection`, and the `html` caret and scrollbar rules.
- `primitives/Chip.tsx`: the `ext` tone.
- `code/theme.ts`, `code/review-gutter.ts`: gutters and line numbers move to `var(--text-muted)`.
- `terminal/terminal-theme.ts`: black → `text-muted`.
- Tests: new `packages/ui/src/dim-tone.test.ts`; `tokens.test.ts` (ADR 0012 values and ratios), `utilities.test.ts`, `terminal-theme.test.ts`, `code/theme.test.ts`.

**Interfaces:** produces the Day ring `#c2410c`, themed placeholders and selection, and the `ext` chip in `attn-title`.

- [ ] **Step 1: Failing tests:**
  - `tokens.test.ts`:
    - `the focus ring reaches 3:1 on bg, surface and surface-2 in every theme`;
    - `placeholders use text-muted at 4.5:1 on bg and surface in every theme`;
    - `the ratios this plan quotes stay true` (4.92, 5.18, 4.35; 5.55, 5.84).
  - `utilities.test.ts`: `selection, caret and scrollbars read tokens`.
  - `display.test.tsx`: `the ext chip reads attn-title`.
  - `dim-tone.test.ts`: `the dim tone colours only idle avatars and disabled controls`.
    - It scans `packages/ui/src` for `text-dim`, `bg-dim`, `border-dim` and `--text-dim`.
    - Allowed: `Avatar.tsx`'s idle `bg-dim`, `disabled:` variants, and the token files (`tokens.css`, `presets.ts`, `token-names.ts`).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `fix(ui): day focus ring, themed placeholders and selection, readable dim text`.

### Task A3: primitive behaviour (F03 ui, F13, F32, F34 card, F37, F50, F56)

**Files:**
- `primitives/TextField.tsx`: errors go through `InlineError announce="action"`.
- `primitives/Select.tsx`: an `error` prop with `aria-invalid`, `aria-describedby` and `InlineError`, as in TextField.
- `primitives/Switch.tsx`: the coarse hit area from Exact values.
- `ai/ApprovalCard.tsx`: answers at `size="md"`, and a `level?: 2 | 3` prop (default 2).
- `ai/CustomPanel.tsx`: its error goes through `InlineError`.
- `ai/Reasoning.tsx`:
  - it never opens or closes by itself; a click toggles it;
  - `AUTO_CLOSE_MS` and the lingering state go;
  - while streaming, the label says "Thinking…", with no ticking counter (§7.2).
- `ai/AuthorGroup.tsx`: the header of a `you` group is `justify-end`.

**Interfaces:** consumes S2 `InlineError`. Produces `SelectProps.error?: string | null` and `ApprovalCardProps.level`.

- [ ] **Step 1: Failing tests:**
  - `TextField.test.tsx`: `an error is red with the icon, an alert, and describes the field`.
  - `Select.long.test.tsx`: `an error sets aria-invalid and describes the trigger`.
  - `controls.test.tsx`: `Switch keeps its 16 × 32 track and gets a 44 px hit area under a coarse pointer`.
  - `ApprovalCard.test.tsx`: `answers are md buttons at every width`; `level 3 renders an h3`.
  - `Reasoning.test.tsx`: `streaming does not open the block, a click does, and the stream's end does not close it`.
  - `conversation.test.tsx`: `a you group's header sits on the right, next to its bubble`.
  - `CustomPanel.test.tsx`: `a panel error is red`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `fix(ui): red field errors, md approval answers, a calm reasoning block`.

### Task A4: terminal palette (F05, F22 optional line)

**Files:**
- New `packages/ui/src/terminal/ansi-palette.ts`: pure `mixHex(a, b, t)` and `withAlpha(hex, alpha)`.
- `terminal-theme.ts`: builds the palette from Exact values with those helpers.
- `TerminalSurface.tsx`: `minimumContrastRatio: 4.5`; `fontFamily` reads `--font-code`, the audit's optional consistency line for the refuted F22.
- Tests: `terminal-theme.test.ts`; new `TerminalSurface.options.test.tsx`, which mocks the `@xterm/xterm` constructor.

**Interfaces:** `terminalTheme(read: TokenReader): ITheme` keeps its signature. It asks for `text-muted` and no longer for `text-dim` (D8, owner, 2026-10-25: the recommendation).

- [ ] **Step 1: Failing tests:**
  - `terminal-theme.test.ts`:
    - `the 16 colours are 16 distinct values in Night, Day and High contrast` (with a reader over `PRESET_TOKENS`);
    - `cyan differs from blue`;
    - `each bright colour is its base mixed 35 % toward text`;
    - `the selection is the agent at 35 % alpha and text on it reaches 7:1 in every theme`;
    - `the reader is asked only for pap tokens, never a literal colour`.
  - `TerminalSurface.options.test.tsx`: `xterm gets minimumContrastRatio 4.5 and the --font-code family`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `fix(ui): a 16-colour terminal and a visible selection`.

### Task A5: the prose measure and wrapping (F02 ui, F57 ui)

**Files:**
- `packages/ui/src/ai/markdown/render.tsx`:
  - these get `max-w-measure`: `p`, `ul`, `ol`, `blockquote`, headings rendered as `p`, and the plain-text body;
  - `p` and `li` also get `text-pretty`;
  - `pre`, code blocks and the table wrapper keep the full width.
- `primitives/TextField.tsx`, `Switch.tsx`: hints get `text-pretty`.
- Test: `markdown/render.test.tsx`.

**Interfaces:** consumes S1 `max-w-measure` (D3, owner, 2026-10-25: the recommendation). Tool cards, diffs and the "you" bubble are untouched.

- [ ] **Step 1: Failing tests:**
  - `render.test.tsx`:
    - `paragraphs, lists and quotes carry the prose measure; code blocks and tables do not`;
    - `paragraphs and list items wrap pretty`;
    - `plain text keeps the measure`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(ui): agent prose at a 72ch measure`.

### Task A6: DESIGN.md and ADR 0086 (F43–F47, every amendment of this plan)

**Files:** `DESIGN.md`; new `docs/adr/0086-night-control-after-the-impeccable-audit.md`; `docs/adr/README.md`; one "Amended by ADR 0086" line in the header of ADR 0012.

**DESIGN.md edits:**
- **§2:** the InlineError rule (red = failed, pink = waits for you; background failures announce as a status, the result of your last action as an alert); every error line carries the icon and words; the `ext` chip uses `attn-title`.
- **§3.2:** the Day `--focus-ring` is `#C2410C`.
- **§4:** the label is 11 px / 600 / uppercase / 0.08em (D1); heading roles: section 16/700, group 13/600, card labels in HUD; field labels stay HUD (D5).
- **§5:** the default density is `mixed` (D2); comfortable steps `6 · 10 · 16 · 24 · 32 · 48` (F47); the rhythm is 4 / 16 / 24 (F16).
- **§6.2:** the tagline uses the label style. **§7.3:** `DeferredFallback`; loading lines end with "…". **§7.4:** the Day ring on bg, surface and surface-2; the palette field's agent bottom rule is the one overlay exception.
- **§9.1:** Input, Textarea and Select take a 1 px `--control-border` (F43); Button `pill`, Button `size="sm"` and Chip `you` (F46); Segmented's visible label and the Switch hit area; rows for `InlineError`, `Heading`, `DeferredFallback` and `CodeText`.
- **§9.2:** agent prose at 72ch with Line length (D3); the real composer, a textarea with mention and command menus, the AttachmentTray, Stop first, Steer | Follow up and one Send (F45, D6); the ANSI map: black → `--text-muted`, a distinct cyan, the brights (D8); approval answers at md; Reasoning stays collapsed; the edit card's summary and diff.
- **§10:** the Settings groups (D4).
- **§11:** catalog values in sentence case; French U+202F; backticks render as code; the glossary lives in `docs/agents/web.md`.
- **§13:** the per-device Line length.
- **§13.1:** the example theme leaves cyan on navy: agent `#60A5FA` on a warm neutral ground (`bg` `#161514`, `surface` `#201E1C`, `text` `#EEEAE6`).
- **§14:** `@theme inline`, with its reason (F44).

**ADR 0086** records D1–D8, supersedes decision 27's compact default and decision 28's full-width prose, amends the Day ring of ADR 0012, and keeps the audit's refusals.

- [ ] **Step 1: Failing test:** `scripts/adr-index.test.ts` (0086 is missing from the index).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Write.** **Step 4:** the `adr-index` and `docs-truth` tests pass.
- [ ] **Step 5: Commit** `docs: Night Control amendments after the impeccable audit (ADR 0086)`.

---

## Lane B: `apps/web`

### Task B1: the Settings frame (F17, F18, F23, F48 settings link; M14 users)

**Files:**
- `features/workspace/model.ts`:
  - `SETTINGS_GROUPS: readonly { id: "you" | "work" | "install"; sections: readonly SettingsSection[] }[]` (D4, owner, 2026-10-25: the recommendation);
  - `SETTINGS_LAYOUT: Record<SettingsSection, "column" | "split">`.
- `routes/settings/SettingsScreen.tsx`:
  - the nav renders the groups through M14's role filter, and hides a group with no visible section;
  - the phone Select lists the sections in group order;
  - a header row holds the h1 and the toolbar slot;
  - a `column` body gets `max-w-settings`;
  - `LINK_CLASSES` loses `rounded-sm`.
- New `routes/settings/SettingsToolbar.tsx`: a context carries the header slot's element, and `SettingsToolbar` portals into it.
- `features/appearance/AppearancePanel.tsx`: the h2 goes, Reset moves into `SettingsToolbar`, the controls column gets `max-w-settings`, and the editor aside stays.
- `features/usage/AutomationSection.tsx`: the h2 that repeats "Automation" goes. Ruling: the form's Save stays at the end of its form, since a submit belongs to its form.
- `features/mcp/McpSection.tsx`, `features/models/ModelsSection.tsx`: blocks outside the list and detail grid get `max-w-settings`.
- Catalog: `i18n/catalog/settings-screen.ts`.

**Interfaces:** consumes S1 `max-w-settings` and M14's `OWNER_SECTIONS` and role. Produces `SETTINGS_GROUPS`, `SETTINGS_LAYOUT` and `SettingsToolbar`.

- [ ] **Step 1: Failing tests:**
  - `features/workspace/model.test.ts`: `every section is in exactly one group`; `every section but appearance, models and mcp is a column`.
  - `routes/settings/settings-groups.test.tsx`:
    - `the nav shows You, Work and This pap, and no Personal`;
    - `a member sees You, Work and This pap with Health only, and a deep link to an owner section opens Appearance`;
    - `the phone select lists sections in group order`;
    - `a column section's body is max-w-settings`.
  - `routes/settings/settings-toolbar.test.tsx`:
    - `Appearance's Reset sits in the header beside the h1, and no heading repeats the section name` (`duplicateNames` is empty);
    - `Automation has no h2 named Automation`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(web): Settings in three groups, one column width, no repeated title`.

### Task B2: Settings contents (F53 sites, F52, F54, F14, F42, D3 setting, F57 web)

**Files:**
- Every `<Segmented` in apps/web (33 sites) gets `labelHidden` only where a heading or the surrounding control already names the choice:
  - the Inbox filter;
  - FileViewer's preview/source;
  - the LaneBody phone and right panes;
  - the FireJournal filter;
  - the gallery's theme and density pickers.
- `features/appearance/model.ts`:
  - `DEFAULT_DEVICE.density: "mixed"` (D2, owner, 2026-10-25: the recommendation);
  - `DeviceAppearance.proseMeasure: "limited" | "full"`, default `limited`;
  - `APPEARANCE_ATTRS` gains `prose` (D3, owner, 2026-10-25: the recommendation).
- `boot-script.js`: `prose` joins `names`.
- `ReadingSection.tsx`: the Line length Segmented.
- `ThemeCards.tsx`: the name on its own line, wrapped and never truncated, with the tag below it.
- `features/models/availability/ProviderRows.tsx`: Switch `meta` holds the chip in `w-24` and the count in `w-28 text-right tabular-nums`.
- `AvailabilitySection.tsx`: a Connected | All filter, default Connected.
- `features/usage/SpendingPanel.tsx`: the help text gets `text-pretty`.
- Catalogs: `settings-appearance.ts`, `settings-availability.ts`.

**Interfaces:** consumes S2 `Segmented.labelHidden` and `Switch.meta`. Produces `data-prose`.

- [ ] **Step 1: Failing tests:**
  - `features/appearance/model.test.ts`: `a device with no stored choice reads density mixed and line length limited`; `a stored compact density is kept`.
  - `boot-script.test.ts`: `replays data-prose before paint` (the list-equality test gains `prose`).
  - `ReadingSection.test.tsx`: `Line length sets data-prose to full and back`; `chat width and motion show their labels`.
  - `ThemeCards.test.tsx`: `shows each theme's whole name and its tag on a line of its own`.
  - `ProviderRows.test.tsx`: `connected providers show by default and every provider after All`; `chip and count sit in fixed-width cells so the switches line up`.
  - `segmented-labels.test.ts`: `labelHidden appears only in the reviewed files` (source scan against `HIDDEN_SEGMENTED`).
  - The `settings-appearance` catalog test: `the font example is IBM Plex Sans`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(web): labelled choices, mixed density, a line length setting`.

### Task B3: Settings headings and rhythm (F15 settings, F16 settings, F34 MCP/Models)

**Files:**
- In `features/appearance`, `models`, `mcp`, `skills`, `usage`, `notifications`, `health`, `auth`, `users` (M14) and `routes/settings`, every `h2`–`h4` that carries `label-hud` becomes a `Heading`:
  - a section under the h1 is `level={2} variant="section"`;
  - its sub-group is `level={3} variant="group"`;
  - a card's own label is `variant="card"`.
- MCP's "Global" and "Project" and Models' "Default model" become h2 (F34).
- Panels stack their top-level sections with `gap-s5`; Appearance moves from `gap-s6` to `gap-s5`. `AppearanceSection.tsx`'s h3 becomes a section `Heading` at level 2.
- New `apps/web/src/heading-style.test.ts`, scoped to these folders.

**Interfaces:** consumes S2 `Heading` (D5, owner, 2026-10-25: the recommendation).

- [ ] **Step 1: Failing tests:**
  - `heading-style.test.ts`: `no h2, h3 or h4 in the Settings folders carries label-hud` (a multi-line JSX scan).
  - `routes/settings/headings.test.tsx`: `MCP and Models have no h3 right under the h1`; `Appearance's section titles are h2 in the section style, gap-s5 apart`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `fix(web): Settings headings that read as headings`.

### Task B4: the project home (F40, F41, F49, F16 home, F15 home, F03 notice)

**Files:**
- `features/home/ProjectHome.tsx`: the h1 uses `text-h1`, body sections sit `gap-s5` apart, and the placeholders change.
- `ActionRow.tsx`: group titles become `Heading level={2} variant="group"`, and the "unavailable" notice turns `text-muted` (it was `text-attn`).
- `RecentWork.tsx`:
  - the title becomes a section `Heading`;
  - the filter becomes a `Segmented` (`labelHidden`, label `home.recent.filter`) (D7, owner, 2026-10-25: the recommendation);
  - a filtered empty list shows `home.recent.emptyFiltered` with a Show all button.
- `features/knowledge/KnowledgeRow.tsx`: Enable becomes `variant="secondary"` (D7, owner, 2026-10-25: the recommendation).
- Catalogs: `launch.ts`, `home.ts`.

**Interfaces:** consumes S2 `Heading` and `Segmented`. `ProjectHome` keeps its allowlisted `"use no memo"`.

- [ ] **Step 1: Failing tests:**
  - `features/home/home-design.test.tsx`:
    - `the home has one primary fill: Launch` (a project home with knowledge absent);
    - `the recent work filter is a radiogroup with All selected`;
    - `a filter with no rows says so, and Show all resets it`;
    - `the placeholder is an example, not the label again`;
    - `the h1 is text-h1 and the body sections are gap-s5 apart`;
    - `an unavailable action's reason is muted, never pink`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.** The home is first-paint, so watch `pnpm budgets`.
- [ ] **Step 5: Commit** `fix(web): one orange action on the home, a heading rhythm`.

### Task B5: headings everywhere else, and the global guard (F15, F34 rest)

**Files:**
- The same conversion as B3 in `features/automation`, `agents`, `lanes`, `inbox`, `files`, `vcs`, `knowledge`, `sessions`, `commands`, `projects`, `github` and the gallery.
- The card headers of automation and agents (`FireJournal`, `DryRunPanel`, `EditorSection`, `GithubTab`) take `variant="card"` with tone `agent` or `muted`.
- `heading-style.test.ts` widens to all of `apps/web/src`.

**Interfaces:** consumes S2 `Heading`.

- [ ] **Step 1: Failing test:** `heading-style.test.ts`: `no h2, h3 or h4 in apps/web carries label-hud`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `fix(web): every heading through Heading`.

### Task B6: the session screen (F59, F33, F12, F20 failure line)

**Files:**
- `features/sessions/SessionScreen.tsx`:
  - a `not_found` from `feedSession` renders `SessionMissing`, with no composer and no status chip;
  - the header reads: name `h1` in `text-h2`, title, then the status, limit and knowledge chips, a spacer, then the policy chip and the ⋯ menu.
- New `SessionMissing.tsx`: an `EmptyState` with the missing copy.
  - "Back to the project" opens the home of the switcher's project.
  - "Search sessions" opens the palette in search mode.
- `Composer.tsx`: the order from Exact values (D6, owner, 2026-10-25: the recommendation). `use-composer.ts` exports `choose(behavior)`.
- `Transcript.tsx`: the failure item gains `session.failure.next`.
- Catalog: `session-screen.ts`.

**Interfaces:** consumes S2 `Segmented` and `EmptyState`. Produces `useComposer().choose`.

- [ ] **Step 1: Failing tests:**
  - `SessionScreen.missing.test.tsx`: `a not_found feed shows the EmptyState with its two actions, and no composer or status chip`.
  - `SessionScreen.header.test.tsx`: `the name is an h1 in text-h2 with its chips after it; policy and the menu end the row`; `duplicateNames is empty`.
  - `Composer.running.test.tsx`:
    - `while running, Stop comes first, Steer | Follow up is one radiogroup, and Send is the only primary`;
    - `choosing Follow up then Send sends followUp and remembers it`.
  - `Transcript.failure.test.tsx`: `a model failure says the transcript is intact and how to retry`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(web): a real missing-session screen, one primary in the composer`.

### Task B7: the edit tool card (F51)

**Files:**
- New `features/sessions/tool-summary.ts`, with `summarize(name, args)`:
  - `edit`, whose args are `{path, edits: {oldText, newText}[]}` or `{path, oldText, newText}`, gives the summary from Exact values;
  - `read` and `write` give the path;
  - any other tool keeps today's JSON, cut at 200.
- `stores/row-view.ts` calls it, and changes nothing else.
- New `EditDiff.tsx`:
  - it parses the full `args` that `sessions.toolOutput` returns when the card opens;
  - it draws one `DiffView` from `@pap/ui/code` per edit, at most 8, then `sessions.tool.edit.more`.
- `ToolItemCard.tsx`: an opened `edit` card renders `EditDiff`. Args that do not parse keep today's view.
- Catalog: `session-tools.ts`. Plus a row for `EditDiff` in `build-output.markers.ts` (the session screen is lazy).

**Interfaces:** consumes `DiffView` and `formatDiffCounts`. Produces `summarize(name: string, args: unknown): { summary: string; argsTruncated: boolean }`.

- [ ] **Step 1: Failing tests:**
  - `tool-summary.test.ts`: `an edit reads "README.md · +4 −0"` (the audit's case); `read and write read their path`; `an unknown tool keeps the JSON summary cut at 200`.
  - `ToolItemCard.edit.test.tsx`: `an opened edit card shows its diff, never raw JSON`; `args that do not parse show the output as before`.
  - `build-output.int.test.ts` row: `the edit diff loads from the lazy @pap/ui/code entry`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `feat(web): the edit card shows its file, its counts and its diff`.

### Task B8: shell, keyboard and phone (F08, F09, F10, F11, F30, F38, F39, F48 rest)

**Files:**
- `routes/shell/AppShell.tsx`: the skip link, and `tabIndex={-1}` on `main#pane-host`.
- `TabBar.tsx`: a running session passes `statusLabel: t("session.status.running")`.
- `AgentRail.tsx`, `features/sessions/Minimap.tsx`, `BottomNav.tsx`: the current states from Exact values.
- `features/commands/palette/CommandPalette.tsx`: the field gets `placeholder` equal to its `aria-label`, and `focus:border-agent`; `ROW_CLASSES` loses `rounded-sm`.
- `TranscriptHits.tsx`, `features/projects/LaneRow.tsx`, `SessionRow.tsx`: drop `rounded-sm` (F48).
- `features/sessions/MessageRow.tsx`, `CrashBanner.tsx`, `features/agents/EventCard.tsx`: `focus-ring` on `<summary>`.
- `routes/shell/MobileShell.tsx`: the title gets `max-xs:hidden`, the project chip `min-w-0 shrink`, and Open items `IconOpenItems`.
- `features/automation/TriggerForm.tsx`, `EditorHeader.tsx`: on a phone, `min-w-0` replaces `min-w-pane`, the same switch as `TasksBoard.tsx:72`.
- Catalog: `shell.ts`.

**Interfaces:** consumes S1 `max-xs:` and `IconOpenItems`.

- [ ] **Step 1: Failing tests:**
  - `AppShell.skip.test.tsx`: `the first focusable is Skip to content and it moves focus to #pane-host`.
  - `TabBar.running.test.tsx`: `a running session's tab says Working to screen readers`.
  - `current-states.test.tsx`: `the current agent, turn and bottom-nav section carry an agent rule, not only a text colour`.
  - `CommandPalette.input.test.tsx`: `the field shows its prompt as a placeholder and an agent bottom rule when focused`.
  - `side-tab.test.ts`: `no class list in apps/web pairs rounded-sm with border-l-2`.
  - `summary-focus.test.ts`: `every summary in apps/web carries the focus ring`.
  - `MobileShell.narrow.test.tsx`: `under 400 px the header hides its title and the chip can shrink; Open items uses Layers`.
  - `TriggerForm.phone.test.tsx`: `on a phone the editor's columns drop min-w-pane`.
  - `AppShell.names.test.tsx`: `the desktop shell's landmarks and tab strip have unique names` (`duplicateNames`).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `fix(web): skip link, visible current states, a 320 px header`.

### Task B9a / B9b / B9c: the InlineError migration (F03, F21)

**Rule for every call site:**
- An inline failure becomes an `InlineError`.
  - `announce="action"` when it answers the click or submit that just happened in that component.
  - `announce="background"` for a load, a poll or a stream failure.
  - `tone="attn"` only when the person must answer.
- Pink texts that are not failures stay pink: approvals, the Inbox, unread counts.
- `role="alert"` remains only in `InlineError`, `Banner`, and the entries of `apps/web/src/alert-allowlist.ts` (each a file and its reason; for example, the transcript's red `data-failure` block).

**Files:**
- **B9a:** `features/sessions`, `lanes`, `vcs`, `files`, `terminal`, `commands`, `home`, `projects`, `knowledge`, `inbox` and `routes` (about 53 alerts). It creates `apps/web/src/inline-error.test.ts` and the allowlist.
- **B9b:** `features/models`, `mcp`, `skills`, `trust`, `policy`, `appearance`, `settings`, `usage`, `health`, `notifications`, `auth` (InviteScreen included), `github` and `users` (about 70).
- **B9c:** `features/agents` and `automation` (about 38). The guard then covers all of `apps/web/src`.

**Interfaces:** consumes S2 `InlineError`.

- [ ] **Step 1: Failing tests:**
  - `inline-error.test.ts`, scoped per part: `no role="alert" outside InlineError, Banner and the allowlist, and none on pink text`.
  - **B9a:** `Transcript: a failed load of older messages is a red polite status`; `a failed send is a red alert`.
  - **B9b:** `TokensPanel: a load failure is a status`; `a failed provider save is an alert`.
  - **B9c:** `a failed trigger save is an alert`; `an agent list load failure is a status`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** each part as `fix(web): red inline errors, polite background failures (part a|b|c)`.

### Task B10: empty and loading states (F19, F28, F29)

**Files:**
- `lib/lazy.tsx`: `LazyBoundary` wraps only its Suspense fallback in `DeferredFallback`; a failed chunk's fallback shows at once. `LazyPanel` and the Settings panels inherit it.
- `routes/settings/GithubSettings.tsx`: uses `settings.github.loading`.
- Catalogs:
  - every `*.loading` value ends with "…" (`agentVm.pi.loading`, `agentFiles.loading`, and the `changes`, `files`, `automation` and `lanes` lines);
  - the six empty states and `settings.theme.empty` get their new copy.
- `access.tokens.empty` renders as an `EmptyState`: title "No tokens yet" / « Aucun jeton pour l'instant », the sentence as purpose.
- Sublists keep one line, by the audit's own rule.

**Interfaces:** consumes S2 `DeferredFallback` and `EmptyState`.

- [ ] **Step 1: Failing tests:**
  - `lib/lazy.deferred.test.tsx`: `a chunk that resolves within 100 ms never shows its fallback`; `a slow one shows it after 100 ms`; `a failed one shows its retry at once`.
  - `i18n/loading-copy.test.ts`: `every loading value ends with … and none with ...`; `Settings › GitHub has a loading key of its own`.
  - `empty-states.test.tsx`: `each first-use empty state says what the list is for` (AgentColumn, FireJournal, TokensPanel, SecretsList, DevicesList and CustomThemes, each with no rows).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `fix(web): no loading flash, empty states that teach`.

### Task B11: errors and vocabulary (F20, F27)

**Files:**
- `i18n/en.ts` and `fr.ts`: the eight errors. The `errorKey` fallback stays `error.internal`, now in three parts.
- `i18n/catalog/shell.ts` and `lanes.ts`: the vocabulary.

**Interfaces:** none new.

- [ ] **Step 1: Failing tests:**
  - `i18n/error-copy.test.ts`:
    - `the eight rewritten errors have their exact EN and FR values`;
    - `an unknown code falls back to the three-part internal error`;
    - `split and pane use one vocabulary in EN and FR` (`shell.tabs.split === lanes.pane.split`, and so on).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.** These are base catalogs, so watch `pnpm budgets`.
- [ ] **Step 5: Commit** `fix(web): errors that say what happened, what is intact and what to do`.

### Task B12: the catalog guards (F24, F26, F55)

**Files:**
- New `i18n/fr-spacing.ts`: `frenchSpacing(text: string): string`, with no imports.
  - `i18n/index.ts` applies it to `fr` in `registerCatalog` and to the initial catalog.
  - `scripts/e2e/catalog-dump.ts` imports it by relative path for `fr`.
- Every all-capitals catalog value becomes sentence case. That covers the audit's 39 plus the B2 and M14 copy. Examples: `CREATE THE GITHUB APP` → "Create the GitHub App"; `OWNER` → "Owner"; `INVITE` → "Invite".
- New `i18n/code-copy.ts`: `CODE_COPY_KEYS: Readonly<Record<MessageKey, "EmptyState" | "Banner" | "InlineError">>` lists the keys whose backticks render through `CodeText`. Every other catalog value loses its backticks.

**Interfaces:** consumes S2 `CodeText`, through EmptyState, Banner and InlineError. Produces `frenchSpacing` and `CODE_COPY_KEYS`.

- [ ] **Step 1: Failing tests:**
  - `i18n/fr-spacing.test.ts`: `puts U+202F before ? ! : ; » and after «, and leaves URLs, times and {placeholders} alone`.
  - `i18n/catalog-guards.test.ts`:
    - `no French value keeps a plain or no-break space before ? ! : ; » or after « once registered`;
    - `no catalog value is all capitals except acronyms`: strip `{placeholders}` and the `ACRONYMS` (API, CPU, CSP, DNS, HTTP, HTTPS, ID, IP, JSON, KVM, MCP, OKF, OTLP, PR, RAM, SSH, TLS, URL, USD, VAPID, VM, YAML), then refuse a rest with no lowercase letter and a run of two capitals;
    - `a backtick appears only in CODE_COPY_KEYS values, and each renders through its component with code and no backtick`.
  - `scripts/e2e/catalog.test.ts`: `the French dump applies the app's spacing`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `fix(web): sentence-case catalogs, French spacing, backticks as code`.

### Task B13: glyphs, the dim tone and custom-theme contrast (F25, F04 web, F07 web, F58 web)

**Files:**
- Glyphs become `Icon`s:
  - `features/agents/status.vm.ts`, `features/automation/TriggerStrip.tsx`: ⏱ ⇢ ◉ ▸ → Schedule, Webhook, Feed, Manual;
  - `features/agents/AgentPackages.tsx`, `features/sessions/SkillChip.tsx`: × → `IconClose`;
  - `features/sessions/ModelMenu.tsx`, `features/models/EnabledSwitches.tsx`: ★ ☆ → `IconStar`, filled or not, in a `size-6` button;
  - `features/models/picker/ModelList.tsx`: ✓;
  - `features/lanes/lane-header.vm.ts` and its renderer: ✓ ✗ → `IconCheck`, `IconFailed`;
  - `features/sessions/CodemodeBody.tsx`: ✓ ✗ ⊘;
  - `features/projects/LaneRow.tsx`: ● → `IconDot`, filled, 14 px;
  - catalogs `lane-compare.ts` and `automation-trigger.ts`: the glyphs become words.
- The dim tone: `features/projects/ProjectHeading.tsx` and `features/lanes/CompareScreen.tsx` move to `text-muted`, guarded by a new `apps/web/src/dim-tone.test.ts`.
- `features/appearance/derive.ts`: `focus-ring` also reaches 3:1 on `surface-2`, and `text-muted` also reaches 4.5:1 on `surface`. Test: `derive.test.ts`.

**Interfaces:** consumes the S1 icons and S2 `Icon.filled`.

- [ ] **Step 1: Failing tests:**
  - `glyph-icons.test.ts`: `no source or catalog value in apps/web uses ⏱ ⇢ ◉ ▸ ★ ☆ ✓ ✗ ⊘ ● as an icon`. × stays allowed only as a count multiplier (`×{n}`).
  - `ModelMenu.star.test.tsx`: `the default model's star is a filled Star in a 24 px button`.
  - `dim-tone.test.ts`: `the dim tone colours only idle avatars and disabled controls`. The token plumbing in `derive.ts` and `boot-script.js` is allowed.
  - `derive.test.ts`: `custom themes keep the focus ring at 3:1 on surface-2 and placeholders at 4.5:1 on bg and surface`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Gate.**
- [ ] **Step 5: Commit** `fix(web): lucide icons for glyphs, readable paths, custom-theme contrast`.

---

## Join

### Task J1: merge, visual check, layout journey, docs

- [ ] Merge lane A, then lane B, into `feat/design-impeccable`. Re-run the gate and `pnpm budgets` on the merged tree: the initial bundle must be at or under 249 KB gzip.
- [ ] **Re-run the screenshot pass, uncommitted**, in the dedicated worktree `/home/ubuntu/Workspace/soulkyu/pap-design-audit`, checked out at the branch head.
  - Restore the journey files from audit §8 as `scripts/e2e/shots-*.e2e.ts`, with `shots-lib.ts` and `shots-seed.ts`.
  - Run the audit's commands under `flock`, with `PAP_E2E_MODE=container` and the filter `shots`, plus the detector in `bwrap`, checked against its SHA-256 sidecar.
  - Record the after-values against this table, then show the owner the captures under the audit's names:

  | Check | v2 | Expected |
  |---|---|---|
  | `undersized-ui-text` at 10.5 px | 366 | 0; labels compute 11 px |
  | Tab title tracking | 0.12em | 0.08em |
  | Agent prose, characters per line at 1440 | 202 | ≤ 90 (72ch in Manrope) |
  | `innerWidth` at 320 (home, session, Settings, Tasks, trigger editor) | 347 | 320 |
  | Day ring on surface-2 | 2.99 | 4.35 |
  | Day placeholder | 3.31 | 5.55 on bg, 5.84 on surface |
  | Terminal | selection 1.19; blue = cyan; bright = normal; Day black 2.43 | 8.98 for text on the selection; 16 distinct colours; black 5.55 |
  | Minimap and bottom nav current | 1.08; text colour only | agent rule; agent bar |
  | Settings column widths | 520 to 1136 px | ≤ 768 px for column sections |
  | First Tab stop | the wordmark; 10 stops to the tab | Skip to content |
  | Missing session | "Not found." in pink | EmptyState |
  | MCP loading flash | 29 ms | nothing before 100 ms |
  | Edit row | raw JSON | `README.md · +4 −0`; diff when opened |

- [ ] **Commit `scripts/e2e/j16-layout.e2e.ts`** (≤ 200 lines; projects `chromium` at 1440 × 900 and `chromium-phone` at 320 × 640). It asserts that the longest agent paragraph has at most 90 characters on every rendered line; that no page above is wider than the viewport at 320; that the first Tab lands on `t("shell.skip")` and Enter focuses `#pane-host`; and that the Day active tab's focus outline reaches 3:1 on its background. It ends on `sessions.list`, a durable state (e2e rule 7).
  - **Why it is worth it under ADR 0071:** happy-dom computes no layout, and three of these failures (F02, F38, F07) showed only on screen. It takes no screenshot, injects nothing, needs no `bypassCSP`, downloads nothing and uses no `waitForTimeout`. It costs about a minute on a 4.5-minute suite (budget 15).
  - The screenshot pass and the detector stay uncommitted: the detector is a downloaded third-party binary and page script that needs `bypassCSP`, which ADR 0071 does not admit, and screenshots are evidence for a person, not assertions.
- [ ] **Journey fixes for the copy changes:** J07 compares `agentsPhone.noVmPurpose` with its backticks removed (it renders as code); J15's French reads go through the spaced dump; steer and follow-up locators become radios. Then run the whole `pnpm test:e2e` once in the container, under `flock`.
- [ ] **Docs:**
  - DESIGN.md: A6 wrote it up front; re-read it against the merged code and fix drift.
  - `docs/agents/web.md`: a short glossary (pane = volet, split = scinder; lane, fan-out and box stay in English, each defined once); the Settings groups and layout; the Line length device setting; `InlineError`, `Heading` and the guards; the new bundle figure.
  - `docs/agents/e2e.md`: fifteen journeys, J16 and its time.
  - Decisions log, at the next free numbers: expected 131 for the owner's D1–D8 and 132 for "built" with the after-values; the merge sha later.
- [ ] Gate. Commit `feat(web): design pass joined, layout journey, docs`.

### Task J2: final review and merge

- [ ] Final review of the branch against the audit and this plan, with the model from the table once the owner confirms it. First focus: Review Focus 1, 2 and 5. Then one Sonnet fix wave and a scoped re-review; the rulings go in the ledger.
- [ ] Rebase on main, squash-merge, `pnpm build`, restart the preview (`systemctl --user restart pap-preview`), run `pap doctor`, push main. No `pap vm setup`: nothing in the agent bundle changes.
- [ ] The owner checks the preview on a phone at 320 px and in Day. Then archive the ledger and the review, add the merge sha to the decisions log, and update memory.

---

## Coverage

Every active finding is a task step, or refused or deferred with its reason.

| F | P | Task | Note |
|---|---|---|---|
| F01 | P1 | A1 | D1 |
| F02 | P1 | S1, A5, B2 | D3 |
| F03 | P1 | S2, A3, B4, B9a–c, A6 | the §2 rule lands in A6 |
| F04 | P1 | A2, B13 | dim guards in both lanes |
| F05 | P1 | A4 | D8 |
| F06 | P1 | A2 | `ext` chip in `attn-title` |
| F07 | P2 | A2, B13 | presets and custom themes |
| F08 | P2 | B8 | |
| F09 | P2 | B8 | the rail is unverified without a VM; covered by a unit test |
| F10 | P2 | B8 | |
| F11 | P2 | B8 | |
| F12 | P2 | B6 | D6 |
| F13 | P2 | A3 | |
| F14 | P2 | B2 | D2 |
| F15 | P2 | S2, B3, B4, B5 | D5 |
| F16 | P3 | B3, B4 | 4 / 16 / 24 rhythm |
| F17 | P2 | B1 | D4, with M14's `users` |
| F18 | P2 | B1 | one 48rem column; split for appearance, models, mcp |
| F19 | P2 | B10 | first-use lists; sublists keep one line (the audit's rule) |
| F20 | P2 | B11, B6 | eight strings and the failure line |
| F21 | P2 | S2, B9a–c | `announce` is required |
| F22 | P3 | refuted | A4 reads `--font-code` (the optional line) |
| F23 | P3 | B1 | Appearance and Automation |
| F24 | P3 | B12 | includes the B2 and M14 copy |
| F25 | P3 | S1, B13 | the star becomes a 24 px button |
| F26 | P3 | B12 | runtime transform; the e2e dump mirrors it |
| F27 | P3 | B11, J1 | glossary in J1 |
| F28 | P3 | B10 | ellipsis guard; GitHub gets its own key |
| F29 | P3 | S2, B10 | 100 ms |
| F30 | P3 | B8 | |
| F31 | P3 | A2 | ruling: the caret uses `--you` for contrast |
| F32 | P3 | A3 | never opens or closes by itself |
| F33 | P3 | B6 | the worst case (7 controls) was not reproduced; the order fixes it |
| F34 | P3 | S2, A3, B3 | |
| F35 | P3 | S2, deferred | words and the icon on every error (S2). The colder Day red is deferred: an identity change with no failing pair |
| F36 | P3 | deferred | the log needs a pane kind of its own, and a later lot reworks lanes for boxes (members have no lanes in M14); the modal stays |
| F37 | P3 | A3 | |
| F38 | P2 | B8 | |
| F39 | P3 | A1, B8 | size via D1; title hidden under 400 px; Layers icon |
| F40 | P3 | B4 | |
| F41 | P3 | B4 | |
| F42 | P3 | B2 | |
| F43 | P3 | A6 | |
| F44 | P3 | A6 | |
| F45 | P3 | A6 | describes the real composer; no tiptap ADR |
| F46 | P3 | A6 | |
| F47 | P3 | A1, A6 | comfortable `--space-6: 48px` |
| F48 | P3 | B1, B8 | corners dropped; the rule stays |
| F49 | P3 | B4 | D7 |
| F50 | P3 | A3 | |
| F51 | P2 | B7 | |
| F52 | P3 | B2 | |
| F53 | P2 | S2, B2 | |
| F54 | P3 | B2 | |
| F55 | P3 | S2, B12 | |
| F56 | P3 | A3 | |
| F57 | P3 | A5, B2 | `text-pretty` |
| F58 | P2 | A2, B13 | |
| F59 | P2 | B6 | |

**Refused, unchanged from audit section 7:** the background grid; 12–16 px card radii; removing the agent message rule; changing the agent violet (twice); replacing Manrope or JetBrains Mono; dropping the mono capitals; skeletons; pill switches; a coloured shell; delight, tours and entrance animations; removing the indeterminate bar; taking the theme preview out of its card; padding for `cramped-padding`. As the refusal note says, only the §13.1 example theme changes (A6).
