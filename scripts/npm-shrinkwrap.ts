import { parse } from "yaml";
import { compareVersions, id, productionClosure, splitKey, type ClosureEntry } from "./npm-lock-closure.ts";

export { productionClosure, type ClosureEntry };

/** The workspace packages whose production dependencies the npm package installs. */
export const PACKAGE_IMPORTERS = ["apps/daemon", "packages/contracts", "packages/pi-host"] as const;

/** Packages whose install script pnpm lets run (`onlyBuiltDependencies`): pnpm's lockfile has no `requiresBuild` for them, so npm's `hasInstallScript` comes from here. */
export const installScriptsOf = (workspaceYaml: string): string[] => {
  const names = ((parse(workspaceYaml) ?? {}) as { onlyBuiltDependencies?: unknown }).onlyBuiltDependencies;
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
};

export interface ShrinkwrapPackage {
  name?: string;
  version: string;
  resolved?: string;
  integrity?: string;
  inBundle?: true;
  optional?: true;
  hasInstallScript?: true;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bundleDependencies?: string[];
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

export interface Shrinkwrap {
  name: string;
  version: string;
  lockfileVersion: 3;
  requires: true;
  packages: Record<string, ShrinkwrapPackage>;
}

const parentOf = (path: string): string => {
  const index = path.lastIndexOf("node_modules/");
  return index <= 0 ? "" : path.slice(0, index - 1);
};
/** npm's lookup: the package folder's own node_modules first, then every ancestor's, up to the root. */
const lookupPath = (
  packages: Record<string, ShrinkwrapPackage>,
  from: string,
  name: string,
): string | undefined => {
  for (let at = from; ; at = parentOf(at)) {
    const path = at === "" ? `node_modules/${name}` : `${at}/node_modules/${name}`;
    if (packages[path] !== undefined) return path;
    if (at === "") return undefined;
  }
};
const lookup = (
  packages: Record<string, ShrinkwrapPackage>,
  from: string,
  name: string,
): ShrinkwrapPackage | undefined => {
  const path = lookupPath(packages, from, name);
  return path === undefined ? undefined : packages[path];
};

/** Paths no root dependency and no edge of another entry resolves to: npm would install them for nobody. */
const unreferenced = (
  packages: Record<string, ShrinkwrapPackage>,
  rootNames: readonly string[],
  edges: (path: string) => [string, string][],
): string[] => {
  const used = new Set(rootNames.map((name) => `node_modules/${name}`));
  for (const path of Object.keys(packages))
    if (path !== "")
      for (const [name] of edges(path)) {
        const target = lookupPath(packages, path, name);
        if (target !== undefined) used.add(target);
      }
  return Object.keys(packages).filter((path) => path !== "" && !used.has(path));
};

const edgesOf = (entry: ClosureEntry): [string, string][] =>
  Object.entries({ ...entry.dependencies, ...entry.optionalDependencies }).sort(([a], [b]) =>
    a.localeCompare(b),
  );

const toPackage = (entry: ClosureEntry, installScripts: readonly string[]): ShrinkwrapPackage => ({
  version: entry.version,
  resolved: entry.resolved,
  integrity: entry.integrity,
  ...(entry.optional ? { optional: true as const } : {}),
  ...(installScripts.includes(entry.name) ? { hasInstallScript: true as const } : {}),
  ...(Object.keys(entry.dependencies).length === 0 ? {} : { dependencies: entry.dependencies }),
  ...(Object.keys(entry.optionalDependencies).length === 0
    ? {}
    : { optionalDependencies: entry.optionalDependencies }),
  ...(entry.peerDependencies === undefined ? {} : { peerDependencies: entry.peerDependencies }),
  ...(entry.os === undefined ? {} : { os: entry.os }),
  ...(entry.cpu === undefined ? {} : { cpu: entry.cpu }),
  ...(entry.libc === undefined ? {} : { libc: entry.libc }),
});

export interface ShrinkwrapInput {
  name: string;
  version: string;
  rootDependencies: Record<string, string>;
  closure: ClosureEntry[];
  bundled: readonly string[];
  installScripts: readonly string[];
}

/**
 * Hoisting: every root dependency sits at the top at exactly the version the manifest asks; every other name goes to the top at
 * the version most dependents use (ties: the highest); the other versions nest under their dependent. A dependent's own nested
 * copies are all placed before any child is expanded, so a deeper package never resolves to a copy placed after its decision.
 */
export function buildShrinkwrap(input: ShrinkwrapInput): Shrinkwrap {
  const { rootDependencies, closure, bundled, installScripts } = input;
  const byId = new Map(closure.map((entry) => [id(entry.name, entry.version), entry]));
  const entryOf = (name: string, version: string): ClosureEntry => {
    const entry = byId.get(id(name, version));
    if (entry === undefined)
      throw new Error(`${name}@${version} is not in the lockfile's production closure`);
    return entry;
  };

  const top = new Map<string, string>();
  const packages: Record<string, ShrinkwrapPackage> = {
    "": {
      name: input.name,
      version: input.version,
      dependencies: rootDependencies,
      bundleDependencies: [...bundled],
    } as ShrinkwrapPackage,
  };
  for (const name of bundled) {
    const version = rootDependencies[name];
    if (version === undefined) throw new Error(`${name} is bundled but not in the root dependencies`);
    packages[`node_modules/${name}`] = { version, inBundle: true };
  }
  for (const [name, version] of Object.entries(rootDependencies)) {
    if (bundled.includes(name)) continue;
    entryOf(name, version);
    top.set(name, version);
  }

  const dependents = new Map<string, Map<string, Set<string>>>();
  for (const entry of closure)
    for (const [name, version] of edgesOf(entry)) {
      const versions = dependents.get(name) ?? new Map<string, Set<string>>();
      versions.set(version, (versions.get(version) ?? new Set()).add(id(entry.name, entry.version)));
      dependents.set(name, versions);
    }
  for (const [name, versions] of dependents) {
    if (top.has(name)) continue;
    const [best] = [...versions].sort(([va, da], [vb, db]) => db.size - da.size || compareVersions(vb, va));
    if (best !== undefined) top.set(name, best[0]);
  }
  const names = [...top.keys()].sort();
  for (const name of names)
    packages[`node_modules/${name}`] = toPackage(entryOf(name, top.get(name) ?? ""), installScripts);

  const expand = (path: string, entry: ClosureEntry): void => {
    const nested: [string, ClosureEntry][] = [];
    for (const [name, version] of edgesOf(entry)) {
      if (lookup(packages, path, name)?.version === version) continue;
      const child = `${path}/node_modules/${name}`;
      const childEntry = entryOf(name, version);
      packages[child] = toPackage(childEntry, installScripts);
      nested.push([child, childEntry]);
    }
    for (const [child, childEntry] of nested) expand(child, childEntry);
  };
  for (const name of names) expand(`node_modules/${name}`, entryOf(name, top.get(name) ?? ""));
  const edgesAt = (path: string): [string, string][] => {
    const found = packages[path];
    const entry = found === undefined ? undefined : byId.get(id(nameOfPath(path), found.version));
    return entry === undefined ? [] : edgesOf(entry);
  };
  for (let dead = unreferenced(packages, Object.keys(rootDependencies), edgesAt); dead.length > 0;) {
    for (const path of dead) Reflect.deleteProperty(packages, path);
    dead = unreferenced(packages, Object.keys(rootDependencies), edgesAt);
  }

  const placed = new Set(
    Object.entries(packages).flatMap(([path, entry]) =>
      path === "" || entry.inBundle === true
        ? []
        : [id(path.slice(path.lastIndexOf("node_modules/") + 13), entry.version)],
    ),
  );
  for (const key of byId.keys())
    if (!placed.has(key)) throw new Error(`${key} is in the closure but no dependency reaches it`);

  return {
    name: input.name,
    version: input.version,
    lockfileVersion: 3,
    requires: true,
    packages: sortPackages(packages),
  };
}

const sortPackages = (packages: Record<string, ShrinkwrapPackage>): Record<string, ShrinkwrapPackage> =>
  Object.fromEntries(Object.entries(packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const nameOfPath = (path: string): string =>
  path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

/** Every way the shrinkwrap differs from the lockfile: a version, an integrity, a registry URL, a missing or extra entry, a broken edge. */
export function verifyShrinkwrap(
  shrinkwrap: Shrinkwrap,
  lock: string,
  importers: readonly string[],
): string[] {
  const closure = productionClosure(lock, importers);
  const byId = new Map(closure.map((entry) => [id(entry.name, entry.version), entry]));
  const problems: string[] = [];
  const seen = new Set<string>();
  const changed = new Map<ShrinkwrapPackage, string>();
  const extra = new Set<string>();
  const entries = Object.entries(shrinkwrap.packages).filter(
    ([path, entry]) => path !== "" && entry.inBundle !== true,
  );
  for (const [path, entry] of entries) {
    const name = nameOfPath(path);
    const expected = byId.get(id(name, entry.version));
    if (expected !== undefined) {
      seen.add(id(name, entry.version));
      if (entry.integrity !== expected.integrity)
        problems.push(`${path}: integrity differs from the lockfile`);
      if (entry.resolved !== expected.resolved) problems.push(`${path}: resolved differs from the lockfile`);
    } else if (closure.some((candidate) => candidate.name === name)) changed.set(entry, path);
    else {
      extra.add(path);
      problems.push(`${path}: ${name} is not in the lockfile's production closure (extra entry)`);
    }
  }
  // a changed version is one problem: it also stands for the lockfile version that no longer appears
  const missing = new Set([...byId.keys()].filter((key) => !seen.has(key)));
  for (const [entry, path] of changed) {
    const name = nameOfPath(path);
    const gone = [...missing].find((key) => splitKey(key).name === name);
    if (gone !== undefined) missing.delete(gone);
    problems.push(
      `${path}: version ${entry.version} is not the lockfile's${gone === undefined ? "" : ` (${gone})`}`,
    );
  }
  for (const key of missing)
    problems.push(`${key} is in the lockfile's production closure but not in the shrinkwrap`);

  const reported = (name: string, version: string, found?: ShrinkwrapPackage): boolean =>
    missing.has(id(name, version)) || (found !== undefined && changed.has(found));
  for (const [path, entry] of entries) {
    if (changed.has(entry)) continue;
    const expected = byId.get(id(nameOfPath(path), entry.version));
    for (const [name, version] of expected === undefined ? [] : edgesOf(expected)) {
      const found = lookup(shrinkwrap.packages, path, name);
      if (found?.version !== version && !reported(name, version, found))
        problems.push(
          `${path}: ${name} resolves to ${found?.version ?? "nothing"}, the lockfile wants ${version}`,
        );
    }
  }
  for (const [name, version] of Object.entries(shrinkwrap.packages[""]?.dependencies ?? {})) {
    const found = shrinkwrap.packages[`node_modules/${name}`];
    if (found?.inBundle !== true && found?.version !== version && !reported(name, version, found))
      problems.push(
        `node_modules/${name}: the root asks for ${version}, the top-level copy is ${found?.version ?? "missing"}`,
      );
  }
  const verifyEdges = (path: string): [string, string][] => {
    const found = shrinkwrap.packages[path];
    const entry = found === undefined ? undefined : byId.get(id(nameOfPath(path), found.version));
    return entry === undefined ? [] : edgesOf(entry);
  };
  const roots = Object.keys(shrinkwrap.packages[""]?.dependencies ?? {});
  for (const path of unreferenced(shrinkwrap.packages, roots, verifyEdges).filter((p) => !extra.has(p)))
    problems.push(`${path}: an entry nothing resolves to`);
  return problems;
}
