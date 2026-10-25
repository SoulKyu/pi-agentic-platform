# ADR 0086: Night Control after the impeccable audit

Status: accepted · Date: 2026-10-25 · Spec: DESIGN.md (amended), plan `docs/plans/2026-10-24-design-impeccable.md`. Decision: 131 (`docs/research/decisions-log.md`). Rulings: R3, R8, R9, R11 of the design lot ledger. Amends ADR 0012 (the Day focus ring). Builds on 0085.

## Context

An audit of the built app with the impeccable detector (58 active findings, `docs/research/design-audit-impeccable-v2.html`) measured real problems: HUD labels below 11 px, agent prose at 135 to 140 characters a line, a Day focus ring at 2.99:1 on surface-2, placeholders at 3.3:1, an unreadable terminal selection, an ANSI black at text-dim, and heading roles that did not differ. The owner took every recommendation of the decision page on 2026-10-25. This ADR records them so DESIGN.md and the code agree.

## Decision

- **D1. HUD labels.** 11 px, weight 600, 0.08em, mono capitals kept (`--text-label`, `--tracking-label`). The identity stays; the size was the defect.
- **D2. Density.** `mixed` is the default (compact controls, 15 px chat prose). This replaces decision 27's compact default. Comfortable gains a sixth step (`--space-6` 48 px).
- **D3. Line length.** Agent prose is capped at 72ch (`--prose-measure`, `max-w-measure`). A per-device setting, Limited or Full width, sets `data-prose` on `<html>`. This replaces decision 28's full-width prose by default. Code blocks, tables and tool output stay full width.
- **D4. Settings groups.** You (appearance, shortcuts, language, notifications, account) · Work (agents, approvals, automation, GitHub) · This pap (models, MCP, skills, users, health). M14's roles stand: a member sees what they could before, and a deep link to an owner section opens Appearance.
- **D5. Headings.** Section 16/700 and group 13/600 in Manrope (`Heading`); card labels and field labels stay HUD.
- **D6. Composer during a run.** Stop (secondary), model pills, Steer | Follow up (Segmented, label hidden), one Send (primary), Attach files.
- **D7. One orange on the home.** Enabling OKF is secondary and the filter is a Segmented, so the launch is the only primary.
- **D8. Terminal palette.** Sixteen colours derived from the role tokens: black `text-muted`, red `err`, green `ok`, yellow `you`, blue `agent`, magenta `attn`, cyan a mix of agent and ok, white a mix of text and text-muted; each bright is its base mixed 35 % toward `text`, bright white is `text`. Minimum contrast 4.5. The selection is `agent` at 35 % alpha.
- **R11 (white).** The audit and D8 ask for 16 distinct colours; a white equal to `text` would make white and bright white the same. So white is mix(text, text-muted, 0.35) and bright white is `text`. Text on the selection measures 9.01, 9.08 and 10.01 (Night, Day, High contrast).
- **R8 (Switch).** Under a coarse pointer the Switch hit area measures 44 × 44: a `before:` box at 7 px and 15 px insets around the 1 px-bordered `h-4 w-8` track. The visible box does not grow.
- **R9 (Settings width).** Column sections share one width, `max-w-settings` (48rem); the inner caps (`max-w-xl`, `max-w-prose`, `max-w-3xl`) are gone.
- **R3 (copy button).** Code blocks carry an always-visible copy button, one `copyText` in `@pap/ui`, the same over HTTP and HTTPS.
- **ADR 0012 amendment.** The Day `--focus-ring` is `#c2410c` (4.92:1 on bg, 5.18 on surface, 4.35 on surface-2), replacing `#ea580c`. Night and High contrast keep the you fill.
- **Contrast and states.** Placeholders are `text-muted` at full opacity; text selection, caret and scrollbar follow the roles. The `ext` chip uses `attn-title`. An error line is red with the warning icon and words (`InlineError`); pink stays for what waits for you. `DeferredFallback` shows a loading line only after 100 ms, and loading lines end with "…".
- **Copy.** Catalog values are sentence case; French gets U+202F before `? ! : ; »` and after `«`; errors say what happened, what is intact and what to do.
- **Tailwind.** DESIGN.md §14 now says `@theme inline`, which `tokens.css` already used so a `data-theme` on a subtree re-themes it.

## Refusals kept

The audit's refusals stand, each for a reason in DESIGN.md: the background grid stays (it can be turned off); corners stay sharp; the 2 px agent rule on messages stays; the violet agent colour stays (flat, fixed meaning); Manrope and JetBrains Mono stay; mono capitals stay; no skeletons beyond the 100 ms deferral; the Switch stays square; no tinted shell; no onboarding tours or entrance animations; the indeterminate bar stays (the one continuous motion, static under reduced motion); the theme preview bubble stays in its card; no extra padding for the "cramped" heuristic.

## Consequences

- Density `mixed` and Limited line length change the first impression for every user without a stored choice; both are one setting away from the old look.
- Custom themes keep 6-digit hex tokens, since the terminal palette mixes them.
- The example theme in §13.1 leaves cyan on navy for a blue agent on a warm neutral ground.
