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
