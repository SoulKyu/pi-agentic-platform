import { parse } from "yaml";

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
export const id = (name: string, version: string): string => `${name}@${version}`;

/** `name@1.2.3(peer@4)(...)` -> name and version without the peer suffix. */
export const splitKey = (key: string): { name: string; version: string } => {
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

export const compareVersions = (a: string, b: string): number => {
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

const stripEdges = (owner: string, edges: Edges | undefined): Map<string, string> =>
  new Map(
    Object.entries(edges ?? {})
      .map(([name, raw]): [string, string] => [name, plainVersion(owner, name, raw)])
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
  );
const show = (edges: Map<string, string>): string => JSON.stringify(Object.fromEntries(edges));

/**
 * The production closure of the given importers, read from pnpm-lock.yaml v9. Peer suffixes are stripped; snapshots of one
 * package that differ only by suffix (same stripped edges) are one entry; snapshots whose stripped edges differ throw, because
 * one npm entry cannot stand for both. `integrity` is copied, never recomputed.
 */
export function productionClosure(lock: string, importers: readonly string[]): ClosureEntry[] {
  const doc = (parse(lock) ?? {}) as Lock;
  const packages = doc.packages ?? {};
  const required = new Map<string, Map<string, string>>();
  const optionalEdges = new Map<string, Map<string, string>>();
  const variants = new Map<string, { key: string; deps: string; optional: string }[]>();
  for (const [key, snapshot] of Object.entries(doc.snapshots ?? {})) {
    const { name, version } = splitKey(key);
    const node = id(name, version);
    const next = stripEdges(key, snapshot.dependencies);
    const nextOptional = stripEdges(key, snapshot.optionalDependencies);
    if (!required.has(node)) {
      required.set(node, next);
      optionalEdges.set(node, nextOptional);
    }
    variants.set(node, [
      ...(variants.get(node) ?? []),
      { key, deps: show(next), optional: show(nextOptional) },
    ]);
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

  for (const node of everything) {
    const [first, ...others] = variants.get(node) ?? [];
    const other = others.find((v) => v.deps !== first?.deps || v.optional !== first?.optional);
    if (first !== undefined && other !== undefined)
      throw new Error(
        `pnpm-lock.yaml: ${node} has snapshots with different dependencies: ${first.key} ${first.deps} ${first.optional} and ${other.key} ${other.deps} ${other.optional}`,
      );
  }

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
