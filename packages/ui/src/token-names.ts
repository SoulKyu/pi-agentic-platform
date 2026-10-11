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
