import { PRESET_THEME_IDS } from "@pap/contracts";

// Kept apart from theme-io.ts, which only the Settings chunk needs: the account merge in the eager graph imports this file.
/** T3's id rule (^[a-z0-9][a-z0-9-]{0,47}$), unique among `taken` and never a preset's id (M3-RT-09). */
export function newThemeId(name: string, taken: ReadonlySet<string>): string {
  const used = new Set<string>([...taken, ...PRESET_THEME_IDS]);
  const slug =
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "theme";
  if (!used.has(slug)) return slug;
  // At most 16 themes plus 3 presets are taken, so a free suffix always exists within the first 20 tries.
  for (let n = 2; ; n++) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
}
