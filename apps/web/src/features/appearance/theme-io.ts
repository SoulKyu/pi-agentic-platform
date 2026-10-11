import { CustomTheme, PRESET_THEME_IDS } from "@pap/contracts";
import { PRESET_TOKENS, type ThemeName } from "@pap/ui";

export const MAX_THEME_FILE_BYTES = 16_384;
const MAX_ERRORS = 20;
const MAX_PATH_CHARS = 64;
const ThemeFile = CustomTheme.omit({ id: true });

export type ThemeFileError =
  | { readonly kind: "too_large" }
  | { readonly kind: "not_json" }
  | { readonly kind: "invalid"; readonly path: string };

export type ThemeFileResult =
  | { readonly ok: true; readonly theme: Omit<CustomTheme, "id"> }
  | { readonly ok: false; readonly errors: ThemeFileError[] };

const TOO_LARGE: ThemeFileResult = { ok: false, errors: [{ kind: "too_large" }] };

/** At most 20 entries, each path clipped: what the file says is shown, never trusted. */
export function themeFileErrors(paths: readonly string[]): ThemeFileError[] {
  return paths.slice(0, MAX_ERRORS).map((path) => ({ kind: "invalid", path: path.slice(0, MAX_PATH_CHARS) }));
}

/** Imported text is untrusted: size first, then JSON, then the contracts schema (only hex colours pass). */
export function parseThemeFile(text: string): ThemeFileResult {
  if (new TextEncoder().encode(text).length > MAX_THEME_FILE_BYTES) return TOO_LARGE;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ kind: "not_json" }] };
  }
  const parsed = ThemeFile.safeParse(value);
  if (parsed.success) return { ok: true, theme: parsed.data };
  return { ok: false, errors: themeFileErrors(parsed.error.issues.map((issue) => issue.path.join("."))) };
}

/** The size is checked on the File before `text()`, so a huge file is never read into memory. */
export async function readThemeFile(file: File): Promise<ThemeFileResult> {
  if (file.size > MAX_THEME_FILE_BYTES) return TOO_LARGE;
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, errors: [{ kind: "not_json" }] }; // an unreadable file reads as no JSON at all
  }
  return parseThemeFile(text);
}

export function exportThemeFile(theme: CustomTheme): string {
  const { name, base, roles } = theme;
  return `${JSON.stringify({ name, base, roles }, null, 2)}\n`;
}

/** FileSaver.js's precedent: Safari and Firefox start the download after the click, so the URL must outlive it. */
const REVOKE_DELAY_MS = 40_000;
const revokeLater = (revoke: () => void): void => {
  setTimeout(revoke, REVOKE_DELAY_MS);
};

/** Hands the file to the browser through a Blob URL, revoked on a later task (`schedule` is injectable for tests). */
export function downloadThemeFile(
  theme: CustomTheme,
  schedule: (revoke: () => void) => void = revokeLater,
): void {
  const url = URL.createObjectURL(new Blob([exportThemeFile(theme)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${theme.id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  schedule(() => URL.revokeObjectURL(url));
}

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

/** A preset as a custom theme's eight roles: the fills, not the darkened text tones, for agent, you and attention. */
export function presetRoles(theme: ThemeName): CustomTheme["roles"] {
  const t = PRESET_TOKENS[theme];
  return {
    bg: t.bg,
    surface: t.surface,
    text: t.text,
    agent: t["agent-fill"],
    you: t["you-fill"],
    attn: t["attn-fill"],
    ok: t.ok,
    err: t.err,
  };
}
