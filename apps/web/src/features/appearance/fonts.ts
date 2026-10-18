import { FONT_FAMILY_PATTERN, type FontFamilyView } from "@pap/contracts";

export type FontKind = "ui" | "mono";

/** After the downloaded family, the stacks the system choices use (tokens.css), so a missing glyph still renders. */
const FALLBACK: Record<FontKind, string> = {
  ui: "ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
const PREFIX = "custom:";

/** The slug of a `custom:<slug>` choice, or null for `manrope`, `jetbrains-mono` and `system`. */
export const customSlug = (value: string): string | null =>
  value.startsWith(PREFIX) ? value.slice(PREFIX.length) : null;

export interface ResolvedFont {
  readonly attr: "default" | "system" | "custom";
  readonly slug: string | null;
  /** The value of `--font-ui` or `--font-code`; null leaves the stylesheet's own. */
  readonly stack: string | null;
}

const DEFAULT_FONT: ResolvedFont = { attr: "default", slug: null, stack: null };

/**
 * A custom family that is installed is used; one that is not (removed on another device, or the list not loaded yet)
 * falls back to the default font, never to an error. The family name goes into a CSS variable only when it is a plain name.
 */
export function resolveFont(
  value: string,
  kind: FontKind,
  families: readonly FontFamilyView[] | null,
): ResolvedFont {
  if (value === "system") return { attr: "system", slug: null, stack: null };
  const slug = customSlug(value);
  const family = slug === null ? undefined : families?.find((entry) => entry.slug === slug);
  if (slug === null || family === undefined || !FONT_FAMILY_PATTERN.test(family.family)) return DEFAULT_FONT;
  return { attr: "custom", slug, stack: `"${family.family}", ${FALLBACK[kind]}` };
}
