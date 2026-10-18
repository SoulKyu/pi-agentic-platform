import { parse } from "yaml";

/** The workspace packages whose production dependencies the npm package installs. */
export const PACKAGE_IMPORTERS = ["apps/daemon", "packages/contracts", "packages/pi-host"] as const;

export interface ClosureEntry {
  name: string;
  version: string;
  integrity: string;
  resolved: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  peerDependencies?: Record<string, string>;
  optional: boolean;
}

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

type Edges = Record<string, string>;
interface LockPackage {
  resolution?: { integrity?: string; [key: string]: unknown };
  os?: string[];
  cpu?: string[];
  libc?: string[];
  peerDependencies?: Edges;
}
interface LockSnapshot {
  dependencies?: Edges;
  optionalDependencies?: Edges;
}
interface LockImporter {
  dependencies?: Record<string, { version: string }>;
  optionalDependencies?: Record<string, { version: string }>;
}
interface Lock {
  importers?: Record<string, LockImporter>;
  packages?: Record<string, LockPackage>;
  snapshots?: Record<string, LockSnapshot>;
}

const PLAIN_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const id = (name: string, version: string): string => `${name}@${version}`;

/** `name@1.2.3(peer@4)(...)` -> name and version without the peer suffix. */
const splitKey = (key: string): { name: string; version: string } => {
  const at = key.indexOf("@", 1);
  if (at === -1) throw new Error(`pnpm-lock.yaml: cannot read the key ${key}`);
  return { name: key.slice(0, at), version: stripPeers(key.slice(at + 1)) };
};
const stripPeers = (version: string): string => {
  const paren = version.indexOf("(");
  return paren === -1 ? version : version.slice(0, paren);
};

const plainVersion = (owner: string, name: string, raw: string): string => {
  const version = stripPeers(raw);
  if (!PLAIN_VERSION.test(version))
    throw new Error(
      `pnpm-lock.yaml: ${owner} depends on ${name} as "${raw}", which is not a registry version`,
    );
  return version;
};

const compareVersions = (a: string, b: string): number => {
  const [coreA = "", preA] = a.split("-", 2);
  const [coreB = "", preB] = b.split("-", 2);
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
};

const mergeEdges = (target: Map<string, string>, edges: Edges | undefined, owner: string): void => {
  for (const [name, raw] of Object.entries(edges ?? {})) {
    const version = plainVersion(owner, name, raw);
    const known = target.get(name);
    if (known === undefined || compareVersions(version, known) > 0) target.set(name, version);
  }
};

/**
 * The production closure of the given importers, read from pnpm-lock.yaml v9. Peer suffixes are stripped, snapshots that differ
 * only by suffix are one entry (a conflicting dependency version keeps the highest), `integrity` is copied, never recomputed.
 */
export function productionClosure(lock: string, importers: readonly string[]): ClosureEntry[] {
  const doc = (parse(lock) ?? {}) as Lock;
  const packages = doc.packages ?? {};
  const required = new Map<string, Map<string, string>>();
  const optionalEdges = new Map<string, Map<string, string>>();
  for (const [key, snapshot] of Object.entries(doc.snapshots ?? {})) {
    const { name, version } = splitKey(key);
    const node = id(name, version);
    const owner = key;
    if (!required.has(node)) required.set(node, new Map());
    if (!optionalEdges.has(node)) optionalEdges.set(node, new Map());
    mergeEdges(required.get(node) ?? new Map(), snapshot.dependencies, owner);
    mergeEdges(optionalEdges.get(node) ?? new Map(), snapshot.optionalDependencies, owner);
  }

  const roots: { node: string; optional: boolean }[] = [];
  for (const importer of importers) {
    const section = doc.importers?.[importer];
    if (section === undefined) throw new Error(`pnpm-lock.yaml has no importer ${importer}`);
    for (const [kind, optional] of [
      ["dependencies", false],
      ["optionalDependencies", true],
    ] as const)
      for (const [name, { version }] of Object.entries(section[kind] ?? {})) {
        if (version.startsWith("link:")) continue;
        roots.push({ node: id(name, plainVersion(importer, name, version)), optional });
      }
  }

  const reach = (start: string[], viaOptional: boolean): Set<string> => {
    const seen = new Set<string>();
    const queue = [...start];
    for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
      if (seen.has(node)) continue;
      seen.add(node);
      const edges = required.get(node);
      if (edges === undefined) throw new Error(`pnpm-lock.yaml has no snapshot for ${node}`);
      const all = viaOptional ? [...edges, ...(optionalEdges.get(node) ?? [])] : [...edges];
      for (const [name, version] of all) queue.push(id(name, version));
    }
    return seen;
  };
  const requiredReach = reach(
    roots.filter((root) => !root.optional).map((root) => root.node),
    false,
  );
  const everything = reach(
    roots.map((root) => root.node),
    true,
  );

  const entries: ClosureEntry[] = [];
  for (const node of everything) {
    const { name, version } = splitKey(node);
    const locked = packages[node];
    const integrity = locked?.resolution?.integrity;
    const resolutionKeys = Object.keys(locked?.resolution ?? {});
    if (typeof integrity !== "string" || resolutionKeys.some((key) => key !== "integrity"))
      throw new Error(`pnpm-lock.yaml: ${node} does not resolve to a registry tarball with an integrity`);
    const dependencies = Object.fromEntries(required.get(node) ?? []);
    const optionalDependencies = Object.fromEntries(optionalEdges.get(node) ?? []);
    const peers = Object.fromEntries(
      Object.entries(locked?.peerDependencies ?? {}).filter(
        ([peer]) => peer in dependencies || peer in optionalDependencies,
      ),
    );
    entries.push({
      name,
      version,
      integrity,
      resolved: `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`,
      dependencies,
      optionalDependencies,
      ...(locked?.os === undefined ? {} : { os: locked.os }),
      ...(locked?.cpu === undefined ? {} : { cpu: locked.cpu }),
      ...(locked?.libc === undefined ? {} : { libc: locked.libc }),
      ...(Object.keys(peers).length === 0 ? {} : { peerDependencies: peers }),
      optional: !requiredReach.has(node),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version));
}

const parentOf = (path: string): string => {
  const index = path.lastIndexOf("node_modules/");
  return index <= 0 ? "" : path.slice(0, index - 1);
};
/** npm's lookup: the package folder's own node_modules first, then every ancestor's, up to the root. */
const lookup = (
  packages: Record<string, ShrinkwrapPackage>,
  from: string,
  name: string,
): ShrinkwrapPackage | undefined => {
  for (let at = from; ; at = parentOf(at)) {
    const found = packages[at === "" ? `node_modules/${name}` : `${at}/node_modules/${name}`];
    if (found !== undefined || at === "") return found;
  }
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
    else problems.push(`${path}: ${name} is not in the lockfile's production closure (extra entry)`);
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
  return problems;
}
