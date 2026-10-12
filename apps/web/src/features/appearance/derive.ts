import type { CustomTheme } from "@pap/contracts";
import type { ThemeToken } from "@pap/ui";
import { contrastRatio, ensureContrast, mix } from "./contrast.ts";

const AA = 4.5;
const NON_TEXT = 3;
const lower = (hex: string) => hex.toLowerCase();

/** DESIGN.md §13.2: shades, inks and day text tones derived from the eight roles. Inputs are validated hex colours. */
export function deriveTheme(theme: CustomTheme): Readonly<Record<ThemeToken, string>> {
  const r = Object.fromEntries(
    Object.entries(theme.roles).map(([k, v]) => [k, lower(v)]),
  ) as CustomTheme["roles"];
  const night = theme.base === "night";
  const tone = (role: string) => ensureContrast(role, r.bg, AA, r.text);
  // ADR 0012 / WCAG 1.4.11: 3:1 against both grounds a control or a focus ring sits on.
  const nonText = (color: string) =>
    ensureContrast(ensureContrast(color, r.bg, NON_TEXT, r.text), r.surface, NON_TEXT, r.text);
  const darkInk = night ? r.bg : r.text;
  const ink = (fill: string) =>
    contrastRatio("#ffffff", fill) >= contrastRatio(darkInk, fill) ? "#ffffff" : darkInk;
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
    "control-border": nonText(mix(r.bg, r.text, 0.38)),
    "focus-ring": nonText(r.you),
    "attn-title": ensureContrast(r.attn, mix(r.surface, r.attn, 26 / 255), AA, r.text),
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
  return [
    text("text", "text"),
    text("agent", "agent"),
    text("you", "you"),
    text("attn", "attn"),
    text("ok", "ok"),
    text("err", "err"),
    fill("agent"),
    fill("you"),
    fill("attn"),
  ];
}
