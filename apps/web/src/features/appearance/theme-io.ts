import { CustomTheme } from "@pap/contracts";
import { PRESET_TOKENS, type ThemeName } from "@pap/ui";
import { downloadJsonFile } from "../../lib/download-file.ts";

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

/** Hands the file to the browser through the shared download helper (`schedule` is injectable for tests). */
export function downloadThemeFile(theme: CustomTheme, schedule?: (revoke: () => void) => void): void {
  downloadJsonFile(`${theme.id}.json`, exportThemeFile(theme), schedule);
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
