import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertNoSymlinks, assertNoStagePath, holdsCredential, missingDist } from "./build-archive-stage.ts";

export interface PackageJson {
  name?: string;
  version?: string;
  type?: string;
  exports?: Record<string, unknown>;
  sideEffects?: boolean;
  dependencies?: Record<string, string>;
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  license?: string;
  repository?: { type: string; url: string };
  bundleDependencies?: string[];
  [key: string]: unknown;
}

export interface ManifestInput {
  daemon: PackageJson;
  contracts: PackageJson;
  piHost: PackageJson;
  catalog: Record<string, string>;
  /** Versions of the Pi SDK packages (`parseLockScope`): listed in `dependencies` so a global install cannot float past them. */
  pinned?: Record<string, string>;
  name?: string;
}

export const PACKAGE_NAME = "@soulkyu/pi-agentic-platform";
const BUNDLED = ["@pap/contracts", "@pap/pi-host"] as const;
const BIN = "./apps/daemon/dist/main.js";
const SHEBANG = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning";
const EXACT = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const REPOSITORY = { type: "git", url: "git+https://github.com/SoulKyu/pi-agentic-platform.git" };
const TEST_OR_MAP = /\.test\.[^/\\]*$|\.map$/;

/** The `catalog:` block of pnpm-workspace.yaml: `name: version` lines, quoted or bare (no YAML library needed). */
export const parseCatalog = (text: string): Record<string, string> => {
  const catalog: Record<string, string> = {};
  let inside = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) inside = /^catalog:\s*$/.test(line);
    else if (inside) {
      const match = /^\s+"?([^":\s]+)"?\s*:\s*([^\s#]+)/.exec(line);
      if (match?.[1] && match[2]) catalog[match[1]] = match[2];
    }
  }
  return catalog;
};

/**
 * The `@earendil-works/*` packages of pnpm-lock.yaml's `packages:` section with their versions. Pi SDK 1.1.0 declares its
 * siblings as `^1.1.0`: without a shrinkwrap npm takes the newest (1.3.0), which breaks pi-coding-agent 1.1.0 (Appendix A).
 */
export const parseLockScope = (text: string, scope = "@earendil-works"): Record<string, string> => {
  const found: Record<string, string> = {};
  let inside = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) inside = /^packages:\s*$/.test(line);
    else if (inside) {
      const match = /^ {2}'?(@[^/@']+\/[^@']+)@(\d+\.\d+\.\d+(?:-[\w.]+)?)'?:/.exec(line);
      if (match?.[1]?.startsWith(`${scope}/`) && match[2]) {
        if (found[match[1]] !== undefined && found[match[1]] !== match[2])
          throw new Error(
            `${match[1]} has two versions in pnpm-lock.yaml: ${found[match[1]]} and ${match[2]}`,
          );
        found[match[1]] = match[2];
      }
    }
  }
  return found;
};

/** Replaces `catalog:` by the catalog version, drops `workspace:` entries, and refuses anything that is not an exact version. */
const resolveDependencies = (from: PackageJson, catalog: Record<string, string>): Record<string, string> => {
  const resolved: Record<string, string> = {};
  for (const [name, spec] of Object.entries(from.dependencies ?? {})) {
    if (spec.startsWith("workspace:")) continue;
    const version = spec.startsWith("catalog:") ? catalog[name] : spec;
    if (version === undefined) throw new Error(`${name} has no entry in the pnpm catalog`);
    if (!EXACT.test(version)) throw new Error(`${name} is not pinned to an exact version: ${version}`);
    resolved[name] = version;
  }
  return resolved;
};

const sortedEntries = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

const unionDependencies = (sources: PackageJson[], catalog: Record<string, string>) => {
  const union: Record<string, string> = {};
  const owner: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, version] of Object.entries(resolveDependencies(source, catalog))) {
      if (union[name] !== undefined && union[name] !== version) {
        throw new Error(
          `${name} has two versions: ${union[name]} (${owner[name]}) and ${version} (${source.name})`,
        );
      }
      union[name] = version;
      owner[name] = source.name ?? "?";
    }
  }
  return sortedEntries(union);
};

/** npm bundles a package only when `dependencies` also lists it (measured: without these two lines the tarball holds no node_modules/@pap). */
const bundledVersions = (contracts: PackageJson, piHost: PackageJson): Record<string, string> =>
  sortedEntries({
    "@pap/contracts": contracts.version ?? "0.0.0",
    "@pap/pi-host": piHost.version ?? "0.0.0",
  });

const withPinned = (
  union: Record<string, string>,
  pinned: Record<string, string>,
): Record<string, string> => {
  for (const [name, version] of Object.entries(pinned)) {
    if (!EXACT.test(version)) throw new Error(`${name} is not pinned to an exact version: ${version}`);
    if (union[name] !== undefined && union[name] !== version)
      throw new Error(`${name} has two versions: ${union[name]} (manifests) and ${version} (pnpm-lock.yaml)`);
  }
  return { ...union, ...pinned };
};

export const resolveManifest = ({
  daemon,
  contracts,
  piHost,
  catalog,
  pinned = {},
  name,
}: ManifestInput): PackageJson => ({
  name: name ?? PACKAGE_NAME,
  version: daemon.version ?? "0.0.0",
  type: "module",
  bin: { pap: BIN },
  engines: { node: ">=24.14 <25" },
  license: "UNLICENSED",
  repository: REPOSITORY,
  dependencies: sortedEntries({
    ...withPinned(unionDependencies([daemon, contracts, piHost], catalog), pinned),
    ...bundledVersions(contracts, piHost),
  }),
  bundleDependencies: [...BUNDLED],
});

/**
 * npm treats every dependency of a bundled package as part of the bundle and installs it as an empty folder (Appendix A). The
 * bundled copies therefore carry none, and the root `dependencies` must list each of them at the same exact version.
 */
export const assertBundledDependencies = (
  manifest: PackageJson,
  sources: PackageJson[],
  catalog: Record<string, string>,
): void => {
  for (const source of sources)
    for (const [name, version] of Object.entries(resolveDependencies(source, catalog)))
      if (manifest.dependencies?.[name] !== version)
        throw new Error(
          `${name} ${version} (a dependency of ${source.name}) is missing from dependencies or has another version there: nothing was packed`,
        );
};

/** A bundled workspace package keeps its version and its `default` export targets; no dependencies (the root lists them), nothing that points at src. */
const bundledManifest = (source: PackageJson): PackageJson => {
  const exports = Object.fromEntries(
    Object.entries(source.exports ?? {}).map(([key, conditions]) => [
      key,
      { default: (conditions as Record<string, string>).default },
    ]),
  );
  return {
    name: source.name,
    version: source.version,
    type: source.type,
    ...(source.sideEffects === undefined ? {} : { sideEffects: source.sideEffects }),
    exports,
  };
};

const readJson = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf8")) as PackageJson;
const writeJson = (path: string, value: PackageJson): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const copyDist = (from: string, to: string): void => {
  assertNoSymlinks(from);
  cpSync(from, to, { recursive: true, filter: (source) => !TEST_OR_MAP.test(source) });
};

/** The final scan of what will be packed: no registry credential, no .npmrc, no test file, no map. Names files, never values. */
export const assertPackageClean = (pkg: string): void => {
  const files = readdirSync(pkg, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  for (const entry of files) {
    const path = join(entry.parentPath, entry.name);
    const shown = relative(pkg, path);
    if ([".gitignore", ".npmignore"].includes(entry.name)) {
      throw new Error(`${shown} would change what npm pack ships: nothing was packed`);
    }
    if (entry.name === ".npmrc") throw new Error(`${shown} must not be packed: nothing was packed`);
    if (TEST_OR_MAP.test(entry.name)) throw new Error(`${shown} is a test file or a map: nothing was packed`);
    if (
      (entry.name === "package.json" || entry.name === "pnpm-workspace.yaml") &&
      holdsCredential(readFileSync(path, "utf8"))
    ) {
      throw new Error(`${shown} looks like it holds a registry credential: nothing was packed`);
    }
  }
};

/** A missing bundled copy would be resolved from the registry by name and version (dependency confusion): refuse instead (M6b-C7). */
export const assertBundled = (pkg: string): void => {
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as PackageJson;
  for (const name of manifest.bundleDependencies ?? []) {
    const file = join(pkg, "node_modules", name, "package.json");
    const copy = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PackageJson) : undefined;
    if (copy?.version === undefined || copy.version !== manifest.dependencies?.[name]) {
      throw new Error(
        `bundled ${name} is missing or has another version than dependencies: nothing was packed`,
      );
    }
    if (copy.dependencies !== undefined)
      throw new Error(
        `bundled ${name} declares dependencies (npm would install them empty): nothing was packed`,
      );
  }
};

const assertBin = (pkg: string): void => {
  const bin = join(pkg, BIN);
  const first = readFileSync(bin, "utf8").split("\n")[0];
  if (first !== SHEBANG) throw new Error(`${BIN} lost its shebang line: nothing was packed`);
  chmodSync(bin, 0o755);
};

export interface BuildNpmOptions {
  repo: string;
  out: string;
  name?: string;
  home?: string;
}

/** Writes `<out>/package/` ready for `npm pack`. The folder is built aside and renamed in place (same folder, so same filesystem) only when every scan passed. */
export const buildNpm = async ({ repo, out, name, home = homedir() }: BuildNpmOptions): Promise<string> => {
  const missing = missingDist(repo);
  if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}: run pnpm build first`);
  const read = (dir: string) => readJson(join(repo, dir, "package.json"));
  const catalog = parseCatalog(readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8"));
  const daemon = read("apps/daemon");
  const contracts = read("packages/contracts");
  const piHost = read("packages/pi-host");
  const lockPath = join(repo, "pnpm-lock.yaml");
  if (!existsSync(lockPath))
    throw new Error("pnpm-lock.yaml is missing: the Pi SDK versions cannot be pinned");
  const pinned = parseLockScope(readFileSync(lockPath, "utf8"));
  if (Object.keys(pinned).length === 0) throw new Error("pnpm-lock.yaml lists no @earendil-works package");
  const manifest = resolveManifest({ daemon, contracts, piHost, catalog, pinned, name });
  assertBundledDependencies(manifest, [contracts, piHost], catalog);
  const bundled = [
    ["contracts", contracts],
    ["pi-host", piHost],
  ] as const;

  const pkg = join(out, "package");
  const building = join(out, `.building-${process.pid}`);
  const staged = join(building, "package");
  rmSync(building, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  try {
    writeJson(join(staged, "package.json"), manifest);
    // kernel/version.js reads ../../package.json: the daemon's name, version and type are all the runtime needs of it
    mkdirSync(join(staged, "apps/daemon"), { recursive: true });
    writeJson(join(staged, "apps/daemon/package.json"), {
      name: daemon.name,
      version: daemon.version,
      type: daemon.type,
    });
    copyDist(join(repo, "apps/daemon/dist"), join(staged, "apps/daemon/dist"));
    copyDist(join(repo, "apps/web/dist"), join(staged, "apps/web/dist"));
    for (const [folder, source] of bundled) {
      const target = join(staged, "node_modules/@pap", folder);
      mkdirSync(target, { recursive: true });
      writeJson(join(target, "package.json"), bundledManifest(source));
      copyDist(join(repo, "packages", folder, "dist"), join(target, "dist"));
    }
    assertPackageClean(staged);
    assertBundled(staged);
    assertBin(staged);
    assertNoStagePath(staged, pkg, home);
    assertNoStagePath(staged, staged, home);
    rmSync(pkg, { recursive: true, force: true });
    renameSync(staged, pkg);
    return pkg;
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: { out: { type: "string" }, name: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const out = resolve(values.out ?? join(repo, ".pap-npm"));
  if (basename(out) === "package") throw new Error("--out is the folder that will hold package/");
  if (existsSync(out) && !lstatSync(out).isDirectory()) throw new Error(`${out} is not a folder`);
  const pkg = await buildNpm({ repo, out, name: values.name });
  console.log(`build-npm: wrote ${pkg}; next: (cd ${pkg} && npm pack)`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`build-npm: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
