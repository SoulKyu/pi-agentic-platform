# web — agent notes

## Appearance model (`apps/web/src/features/appearance/`)

- Pure functions, no DOM. `parseAccount` reads the stored account document field by field: each enum/boolean falls back on its own, `customThemes` keeps valid entries (first duplicate id wins, at most 16 kept, 64 examined), a side whose theme is gone or sits on the wrong base falls back to `night`/`day`. Never reset the whole document for one bad field.
- Mode picks the side (Night / Day / System). Dark side: Night Control, High contrast or a custom night theme. Light side: Day Papier or a custom day theme.
- `deriveTheme` mixes (8, 13, 22, 35, 38, 55, 58 %) are pap's own numbers for DESIGN §13.2's rules. `control-border`, `focus-ring` reach 3:1 on bg and surface; `attn-title` 4.5:1 on the attention tint over the surface (ADR 0012).
- `contrast.ts` and `derive.ts` are the only `apps/web` files exempt from `pap/no-raw-colors` (colour math, pinned by tests).
- Language is per device, not in the account document.
