import {
  chmodSync,
  copyFileSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { credentialName } from "@pap/contracts";
import { within } from "../../kernel/fs/boundary.ts";

/** R28: where the image keeps Pi's profile (read-only); the guest seeds `/agent/.pi/agent` from it. */
export const IMAGE_AGENT_DIR = "/opt/pap/pi-agent";
/** R34, RT-16: every URL the image holds names the relay's port. */
export const RELAY_BASE = "http://llm.internal:7842";
export const PLACEHOLDER_KEY = "pap-placeholder";
export const SETTINGS_KEYS: readonly string[] = [
  "compaction",
  "defaultThinkingLevel",
  "modelThinkingLevels",
  "enabledModels",
  "defaultProvider",
  "defaultModel",
];
/** R9: the Pi apis the relay serves. */
const SERVED_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
]);
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_MODELS = 512;

/** RT-18: inside every copied folder, a name that can hold a credential never enters. */
const DENIED_NAME =
  /^(?:\.env.*|\.npmrc|\.netrc|\.gitconfig|.*\.pem|.*\.key|id_.*|.*auth.*\.json|.*credentials.*|.*\.(?:sqlite|db)(?:-wal|-shm|-journal)?)$/i;
export const isDeniedName = (name: string): boolean => name === ".git" || DENIED_NAME.test(name);

/** The budget of one profile build, shared by every folder it copies. `max*` override the limits in tests. */
export interface CopyRun {
  files: number;
  bytes: number;
  readonly skipped: string[];
  /** Files of the owner's that must never enter, whatever their name: a hard link to one is skipped (device and inode). */
  readonly denyIds?: ReadonlyArray<{ readonly dev: number; readonly ino: number }>;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}
export const COPY_LIMITS = Object.freeze({ files: 100_000, bytes: 1024 ** 3, depth: 48 });
const SKIPPED_MAX = 200;

export function skip(run: CopyRun, note: string): void {
  if (run.skipped.length < SKIPPED_MAX) run.skipped.push(note);
  else if (run.skipped.length === SKIPPED_MAX) run.skipped.push("more entries skipped");
}

/**
 * Copies one package folder. Not copied: `.git`, a denied name, a special file, a link whose resolved target leaves
 * the package (or is itself denied or missing). A link that stays inside is copied as a relative link.
 */
export function copyPackage(srcRoot: string, dstRoot: string, run: CopyRun, label: string): void {
  const realRoot = realpathSync(srcRoot);
  const maxFiles = run.maxFiles ?? COPY_LIMITS.files;
  const maxBytes = run.maxBytes ?? COPY_LIMITS.bytes;
  const walk = (rel: string, depth: number): void => {
    if (depth > COPY_LIMITS.depth) throw new RangeError(`profile folder too large: ${label}`);
    mkdirSync(join(dstRoot, rel), { recursive: true });
    for (const name of readdirSync(join(realRoot, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const note = `${label}/${path}`;
      if (isDeniedName(name)) {
        skip(run, `${note}: name`);
        continue;
      }
      const from = join(realRoot, path);
      const stat = lstatSync(from);
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (stat.isFile() && run.denyIds?.some((id) => id.dev === stat.dev && id.ino === stat.ino)) {
        skip(run, `${note}: name`);
      } else if (stat.isFile()) {
        run.files += 1;
        run.bytes += stat.size;
        if (run.files > maxFiles || run.bytes > maxBytes)
          throw new RangeError(`profile folder too large: ${label}`);
        copyFileSync(from, join(dstRoot, path), constants.COPYFILE_EXCL);
        chmodSync(join(dstRoot, path), stat.mode & 0o111 ? 0o755 : 0o644);
      } else if (stat.isSymbolicLink()) {
        const inside = linkTarget(realRoot, from);
        if (inside === null) skip(run, `${note}: link`);
        else
          symlinkSync(
            relative(dirname(join(dstRoot, path)), join(dstRoot, inside)) || ".",
            join(dstRoot, path),
          );
      } else skip(run, `${note}: special file`);
    }
  };
  walk("", 0);
}

/** The link's resolved target relative to the package, or null when it leaves it, is missing or is a denied name. */
function linkTarget(realRoot: string, link: string): string | null {
  let real: string;
  try {
    real = realpathSync(link);
  } catch {
    return null;
  }
  if (!within(realRoot, real)) return null;
  const rel = relative(realRoot, real);
  return rel.split(sep).some(isDeniedName) ? null : rel;
}

export type PackageRef =
  | { kind: "npm"; name: string; version: string | null }
  | { kind: "git"; host: string; path: string; ref: string | null }
  | { kind: "local"; path: string }
  | { kind: "unknown" };
const UNKNOWN: PackageRef = { kind: "unknown" };

/** A `packages` entry of Pi's settings: `npm:name@version`, a git URL (`git:` prefix or not), or a local path. */
export function parsePackageSource(source: string): PackageRef {
  if (source.length === 0 || source.length > 1024 || source.includes("\0")) return UNKNOWN;
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : null;
    return NPM_NAME.test(name) && (version === null || /^[0-9A-Za-z.+-]{1,64}$/.test(version))
      ? { kind: "npm", name, version }
      : UNKNOWN;
  }
  const prefix = /^(?:git:)?(?:git\+)?(?:(?:git|https?|ssh):\/\/)?/.exec(source)?.[0] ?? "";
  const scheme = prefix === "" ? null : prefix;
  if (scheme === null && !/^git@[^/:]+:/.test(source)) return { kind: "local", path: source };
  let rest = scheme === null ? source : source.slice(scheme.length);
  const lastSlash = rest.lastIndexOf("/");
  const at = rest.indexOf("@", lastSlash + 1);
  const ref = at >= 0 ? rest.slice(at + 1) : null;
  if (at >= 0) rest = rest.slice(0, at);
  rest = rest.replace(/^[^/@]*@/, "");
  if (scheme === null || !rest.includes("/")) rest = rest.replace(":", "/");
  const parts = rest.replace(/\.git$/, "").split("/");
  const [host, ...path] = parts;
  if (host === undefined || path.length === 0 || ![host, ...path].every((p) => SEGMENT.test(p)))
    return UNKNOWN;
  if (ref !== null && !/^[0-9A-Za-z._/-]{1,128}$/.test(ref)) return UNKNOWN;
  return { kind: "git", host, path: path.join("/"), ref };
}

/** `settings.json` reduced to the allowlisted keys (packages and skills are rewritten by the caller). */
export function sanitizeSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) if (Object.hasOwn(raw, key)) kept[key] = raw[key];
  return kept;
}

export interface ModelsSource {
  readonly providers: Readonly<Record<string, unknown>>;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Pi documents `$NAME`, `${NAME}` and `!command` as ways to name a credential without writing it: no secret value. */
export const isLiteralValue = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith("!") &&
  !/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(value);

/** Literal strings of provider `headers` and `apiKey` in the owner's models.json: known secrets for the scan. */
export function literalValuesOf(source: ModelsSource): string[] {
  const values: string[] = [];
  for (const provider of Object.values(source.providers)) {
    if (!isRecord(provider)) continue;
    if (typeof provider.apiKey === "string" && isLiteralValue(provider.apiKey)) values.push(provider.apiKey);
    for (const holder of [provider, ...(Array.isArray(provider.models) ? provider.models : [])]) {
      if (!isRecord(holder) || !isRecord(holder.headers)) continue;
      for (const [name, value] of Object.entries(holder.headers))
        if (typeof value === "string" && credentialName(name) && isLiteralValue(value)) values.push(value);
    }
  }
  return values;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function modelOf(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 256) return null;
  const model: Record<string, unknown> = { id: raw.id };
  if (typeof raw.name === "string") model.name = raw.name.slice(0, 256);
  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
  if (Array.isArray(raw.input)) model.input = raw.input.filter((item) => item === "text" || item === "image");
  for (const key of ["contextWindow", "maxTokens"]) if (num(raw[key]) !== undefined) model[key] = raw[key];
  if (isRecord(raw.cost)) {
    const cost: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      const value = num(raw.cost[key]);
      if (value !== undefined) cost[key] = value;
    }
    model.cost = cost;
  }
  return model;
}

/**
 * RT-16, RT-18: a `models.json` that points each provider at the relay with a placeholder key and no headers (the
 * relay adds them host-side). Only the fields the allowlist names are carried; `extraProviders` are Pi providers that
 * the owner's models.json does not list (built-ins named by the settings).
 */
export function modelsFile(
  source: ModelsSource,
  extraProviders: Iterable<string>,
  skipped: string[],
): { providers: Record<string, Record<string, unknown>> } {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(source.providers)) {
    if (!PROVIDER.test(name)) {
      skipped.push(`provider:${name.slice(0, 64)}: name`);
      continue;
    }
    const provider: Record<string, unknown> = { baseUrl: `${RELAY_BASE}/${name}`, apiKey: PLACEHOLDER_KEY };
    if (isRecord(raw) && raw.api !== undefined) {
      if (typeof raw.api !== "string" || !SERVED_APIS.has(raw.api)) {
        skipped.push(`provider:${name}: api not served by the relay`);
        continue;
      }
      provider.api = raw.api;
    }
    if (isRecord(raw) && Array.isArray(raw.models)) {
      provider.models = raw.models
        .slice(0, MAX_MODELS)
        .map(modelOf)
        .filter((model) => model !== null);
    }
    providers[name] = provider;
  }
  for (const name of extraProviders)
    if (PROVIDER.test(name) && !Object.hasOwn(providers, name))
      providers[name] = { baseUrl: `${RELAY_BASE}/${name}`, apiKey: PLACEHOLDER_KEY };
  return { providers };
}
