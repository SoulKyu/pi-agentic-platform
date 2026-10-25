import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CodemodeSettings, HELPER_OPS } from "@pap/contracts/pi-host";
import { withKey } from "../mcp-file.ts";
import { defineOp, type HelperContext, HelperOpError } from "../ops.ts";
import { PiFileRefused, readPiFile, writePiFile } from "../pi-file.ts";
import { acquire } from "./auth-store.ts";

type Ctx = Pick<HelperContext, "agentDir" | "home">;
type Settings = Record<string, unknown>;

const isRecord = (value: unknown): value is Settings =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const MODIFIER = /^[+-]/;
const namesCodemode = (entry: string): boolean => entry.replace(MODIFIER, "") === "codemode";

/** Automatic drops every entry naming codemode; Always makes `+codemode` the one entry, unless the list already enables it. */
function defaultToolsFor(
  current: readonly string[] | undefined,
  choice: "automatic" | "always",
): readonly string[] | undefined {
  const list = current ?? [];
  if (choice === "automatic") {
    const rest = list.filter((entry) => !namesCodemode(entry));
    if (rest.length === list.length) return current;
    // An emptied list, plain or modifier-only, is removed: `defaultTools: []` means no tools at all (MC44 M7).
    return rest.length === 0 ? undefined : rest;
  }
  const enabled = list.some((entry) => entry === "codemode" || entry === "+codemode");
  const blocked = list.includes("-codemode");
  if (enabled && !blocked) return current;
  return [...list.filter((entry) => !namesCodemode(entry)), "+codemode"];
}

export function codemodeView(settings: Settings): CodemodeSettings {
  const tools = settings.defaultTools;
  const codemode = isRecord(settings.codemode) ? settings.codemode : {};
  const budget = codemode.inlineBudget;
  return {
    choice:
      Array.isArray(tools) &&
      tools.some((entry) => entry === "codemode" || entry === "+codemode") &&
      !tools.includes("-codemode")
        ? "always"
        : "automatic",
    mode: codemode.mode === "only" ? "only" : "on",
    inlineBudget:
      typeof budget === "number" && Number.isInteger(budget) && budget >= 0 && budget <= 1_000_000
        ? budget
        : null,
  };
}

/**
 * Pi spells a disabled built-in `-builtin:<name>` in the `extensions` array of settings.json (SDK docs/settings.md,
 * "Resources"); the last `builtin:codemode` entry wins. Project settings can override it; only the global file is read here.
 */
export function codemodeBuiltinOff(settings: Settings): boolean {
  const entries = Array.isArray(settings.extensions) ? settings.extensions : [];
  const last = entries.filter(
    (entry) => entry === "-builtin:codemode" || entry === "+builtin:codemode" || entry === "builtin:codemode",
  );
  return last.at(-1) === "-builtin:codemode";
}

/** The current keys for the overview: defaults when the file is missing, `null` when it cannot be read or is not an object. */
export async function readCodemodeState(
  ctx: Ctx,
): Promise<{ readonly settings: CodemodeSettings | null; readonly builtinOff: boolean }> {
  try {
    const { text } = await readPiFile(join(ctx.agentDir, "settings.json"), [ctx.agentDir, ctx.home]);
    if (text === null) return { settings: codemodeView({}), builtinOff: false };
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed)
      ? { settings: codemodeView(parsed), builtinOff: codemodeBuiltinOff(parsed) }
      : { settings: null, builtinOff: false };
  } catch {
    return { settings: null, builtinOff: false };
  }
}

/**
 * The code mode keys of the global `settings.json` (M7R92): `defaultTools`, `codemode.mode` and `codemode.inlineBudget`.
 * Pi's SettingsManager has no setter for them, so the file is edited here and written with `writePiFile`. A write by the `pi`
 * CLI between the read and the rename is kept out by Pi's own `settings.json.lock` folder, held around both (MC59). Every
 * other key, and the file's mode, are kept.
 */
export async function setCodemode(
  params: { choice?: "automatic" | "always"; mode?: "on" | "only"; inlineBudget?: number | null },
  ctx: Ctx,
): Promise<CodemodeSettings> {
  const path = join(ctx.agentDir, "settings.json");
  const roots = [ctx.agentDir, ctx.home];
  let release: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    release = await acquire(`${path}.lock`);
    const { text } = await readPiFile(path, roots);
    let parsed: unknown = {};
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HelperOpError("config_invalid", "settings.json");
      }
    }
    if (!isRecord(parsed)) throw new HelperOpError("config_invalid", "settings.json");
    let settings: Settings = parsed;
    const tools = settings.defaultTools;
    const codemode = settings.codemode;
    if (tools !== undefined && !(Array.isArray(tools) && tools.every((entry) => typeof entry === "string")))
      throw new HelperOpError("config_invalid", "defaultTools");
    if (codemode !== undefined && !isRecord(codemode)) throw new HelperOpError("config_invalid", "codemode");
    const before = JSON.stringify(settings);
    if (params.choice !== undefined)
      settings = withKey(
        settings,
        "defaultTools",
        defaultToolsFor(tools as readonly string[] | undefined, params.choice),
      );
    if (params.mode !== undefined || params.inlineBudget !== undefined) {
      let inner: Settings = isRecord(settings.codemode) ? settings.codemode : {};
      if (params.mode !== undefined)
        inner = withKey(inner, "mode", params.mode === "only" ? "only" : undefined);
      if (params.inlineBudget !== undefined)
        inner = withKey(inner, "inlineBudget", params.inlineBudget ?? undefined);
      settings = withKey(settings, "codemode", Object.keys(inner).length === 0 ? undefined : inner);
    }
    if (JSON.stringify(settings) !== before) {
      const indent = text === null ? "  " : (/\n([ \t]+)\S/.exec(text)?.[1]?.slice(0, 10) ?? "  ");
      await writePiFile(path, `${JSON.stringify(settings, null, indent)}\n`, {
        roots,
        mode: 0o600,
        keepMode: true,
      });
    }
    return codemodeView(settings);
  } catch (error) {
    if (error instanceof PiFileRefused)
      throw new HelperOpError(
        error.reason === "hard-link" ? "config_hard_link" : "config_path_refused",
        error.reason,
      );
    throw error;
  } finally {
    await release?.();
  }
}

export const mcpCodemodeOp = defineOp({
  params: HELPER_OPS["mcp.codemode"].params,
  run: (params, ctx) => setCodemode(params, ctx),
});
