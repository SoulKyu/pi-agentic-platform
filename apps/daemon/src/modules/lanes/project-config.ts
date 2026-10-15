import { createHash } from "node:crypto";
import { CONFIG_FIELDS } from "@pap/contracts";
import { isMap, isScalar, parseDocument } from "yaml";
import { z } from "zod";

export const PROJECT_CONFIG_LIMITS = {
  fileBytes: 64 * 1024,
  topKeys: 256,
  scriptChars: 16_384,
  entries: 100,
  pathChars: 1024,
} as const;

export const PROJECT_CONFIG_PATH = ".pi/project.yaml";

/** Relative, canonical, inside the repository, never through `.git` (M9R24). */
export function isCleanRelative(path: string): boolean {
  if (path.length === 0 || path.length > PROJECT_CONFIG_LIMITS.pathChars) return false;
  if (path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  return path
    .split("/")
    .every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git",
    );
}
const Script = z
  .string()
  .min(1)
  .max(PROJECT_CONFIG_LIMITS.scriptChars)
  .refine((text) => !text.includes("\0"));
const RelPath = z.string().refine(isCleanRelative);
const FIELDS = {
  setup: Script,
  archive: Script,
  test: Script,
  copy: z.array(RelPath).max(PROJECT_CONFIG_LIMITS.entries),
  link: z.array(RelPath).max(PROJECT_CONFIG_LIMITS.entries),
  branchPrefix: z
    .string()
    .max(64)
    .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*(?:[A-Za-z0-9][A-Za-z0-9._-]*-?)?$/),
  waitForSetup: z.boolean(),
  forge: z.enum(["github", "gitlab", "gitea"]),
} as const satisfies Record<(typeof CONFIG_FIELDS)[number], z.ZodType>;
type Field = keyof typeof FIELDS;
export type ProjectConfig = { [K in Field]?: z.infer<(typeof FIELDS)[K]> };
export type ConfigRead =
  | { readonly ok: true; readonly config: ProjectConfig; readonly warnings: readonly Field[] }
  | { readonly ok: false; readonly error: "too_large" | "invalid_yaml" | "not_a_map" };

const INVALID = { ok: false, error: "invalid_yaml" } as const;

/**
 * One bad field is dropped and named; a file YAML cannot read, with an alias, a custom tag, a duplicate or non-scalar
 * top-level key, or more than 256 top-level keys is refused whole. `uniqueKeys: false`: yaml's own check is quadratic
 * (13 000 keys under the size cap took 1.3 s, M9-RT-12), so the top level is checked here in one pass.
 */
export function readProjectConfig(bytes: Buffer): ConfigRead {
  if (bytes.length > PROJECT_CONFIG_LIMITS.fileBytes) return { ok: false, error: "too_large" };
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(bytes.toString("utf8"), {
      schema: "core",
      uniqueKeys: false,
      prettyErrors: false,
    });
  } catch {
    return INVALID;
  }
  // A warning is yaml saying it did not understand something (an unresolved tag): never run on a guess.
  if (doc.errors.length > 0 || doc.warnings.length > 0) return INVALID;
  const top = doc.contents;
  if (top === null) return { ok: true, config: {}, warnings: [] };
  if (!isMap(top)) return { ok: false, error: "not_a_map" };
  if (top.items.length > PROJECT_CONFIG_LIMITS.topKeys) return INVALID;
  const keys = new Set<string>();
  for (const pair of top.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string" || keys.has(pair.key.value)) return INVALID;
    keys.add(pair.key.value);
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    return INVALID;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "not_a_map" };
  const config: Record<string, unknown> = {};
  const warnings: Field[] = [];
  for (const field of Object.keys(FIELDS) as Field[]) {
    if (!Object.hasOwn(value, field)) continue;
    const parsed = FIELDS[field].safeParse((value as Record<string, unknown>)[field]);
    if (parsed.success) config[field] = parsed.data;
    else warnings.push(field);
  }
  return { ok: true, config: config as ProjectConfig, warnings };
}
export const scriptHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
