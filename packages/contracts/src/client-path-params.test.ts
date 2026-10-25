import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CLIENT_PATH_MARKER, methods } from "./index.ts";

const PATH_KEY = /(^|_)(path|cwd|root|dir|folder|file)s?$/;
const isPathKey = (key: string) => PATH_KEY.test(key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  valueType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  left?: z.ZodType;
  right?: z.ZodType;
  items?: z.ZodType[];
  getter?: () => z.ZodType;
}
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Every string leaf under a path-like key that is not a `ClientPath`, as `a.b[]` key paths. */
export function rawPathLeaves(schema: z.ZodType, key = "", trail = ""): string[] {
  if (schema.description === CLIENT_PATH_MARKER) return [];
  const def = defOf(schema);
  const child = (next: z.ZodType | undefined, k = key, t = trail) =>
    next === undefined ? [] : rawPathLeaves(next, k, t);
  switch (def.type) {
    case "string":
      return isPathKey(key) ? [trail] : [];
    case "object":
      return Object.entries(def.shape ?? {}).flatMap(([k, v]) =>
        rawPathLeaves(v, k, trail === "" ? k : `${trail}.${k}`),
      );
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
    case "catch":
      return child(def.innerType);
    case "array":
      return child(def.element, key, `${trail}[]`);
    case "set":
      return child(def.valueType, key, `${trail}[]`);
    case "union":
      return (def.options ?? []).flatMap((option) => child(option));
    case "record":
    case "map":
      return child(def.valueType, key, `${trail}{}`);
    case "tuple":
      return (def.items ?? []).flatMap((item) => child(item, key, `${trail}[]`));
    case "intersection":
      return [...child(def.left), ...child(def.right)];
    case "pipe":
      return [...child(def.in), ...child(def.out)];
    case "lazy":
      return child(def.getter?.());
    default:
      return [];
  }
}

/** `method` + key path, each with the reason it is not a host path a client points at. */
const ALLOWED: Record<string, string> = {
  "agents.files.remove:path": "a path inside the agent's VM home, never a host path",
  "vcs.fileDiff:path": "repo-relative, resolved under the already gated root",
  "vcs.fileDiff:oldPath": "repo-relative, resolved under the already gated root",
  "lanes.commit:paths[]": "worktree-relative; lanes:* is denied to members",
  "lanes.suggestCommit:paths[]": "worktree-relative; lanes:* is denied to members",
  "lanes.reviewState.set:doc.seen[].path": "worktree-relative; lanes:* is denied to members",
  "lanes.reviewState.set:doc.comments[].path": "worktree-relative; lanes:* is denied to members",
};

describe("params of every method", () => {
  it("use ClientPath for every path-like string, so the dispatcher gate sees it", () => {
    const offenders: string[] = [];
    for (const [name, def] of Object.entries(methods))
      for (const leaf of rawPathLeaves(def.params))
        if (ALLOWED[`${name}:${leaf}`] === undefined) offenders.push(`${name}:${leaf}`);
    expect(offenders).toEqual([]);
  });

  it("allow-lists only entries that still exist", () => {
    const live = new Set<string>();
    for (const [name, def] of Object.entries(methods))
      for (const leaf of rawPathLeaves(def.params)) live.add(`${name}:${leaf}`);
    for (const entry of Object.keys(ALLOWED)) expect(live.has(entry), entry).toBe(true);
  });

  it("finds a raw string under cwd, wrapped or not, and accepts a ClientPath", () => {
    const raw = z.object({ cwd: z.string().min(1) });
    expect(rawPathLeaves(raw)).toEqual(["cwd"]);
    expect(
      rawPathLeaves(z.object({ list: z.array(z.object({ projectRoot: z.string().optional() })) })),
    ).toEqual(["list[].projectRoot"]);
    expect(
      rawPathLeaves(z.discriminatedUnion("k", [z.object({ k: z.literal("a"), files: z.array(z.string()) })])),
    ).toEqual(["files[]"]);
    expect(rawPathLeaves(z.object({ profile: z.string() }))).toEqual([]);
    const fake = { params: raw };
    expect(rawPathLeaves(fake.params).length).toBeGreaterThan(0);
  });
});
