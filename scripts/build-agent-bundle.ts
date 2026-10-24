import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Runner } from "./build-archive-stage.ts";

/** pi-host's `dist` plus a flat production `node_modules`: what the base image of the agent VMs is built from (T14b). */
export const AGENT_BUNDLE = "packages/pi-host/dist-agent";
/** What the guest and the relay start from; a bundle without them builds an image that cannot boot. */
export const REQUIRED_FILES = [
  "dist/guest/main.js",
  "dist/relay/main.js",
  "package.json",
  "bin/gh",
  "bin/pap-git-credential",
  "bin/pap-ssh-sign",
] as const;
/** `pnpm deploy` copies these beside `dist`; the image needs none of them. */
const PRUNED = ["src", "dist-agent", "tsconfig.json", "tsconfig.build.json", "pnpm-lock.yaml"] as const;
/** pnpm's own state: timestamps, the store dir and the builder's paths. The bundle is flat; nothing reads them. */
const PNPM_STATE = [".modules.yaml", ".pnpm", ".pnpm-workspace-state-v1.json"] as const;
/** The workspace copy of contracts keeps its sources and configs; only `dist` and `package.json` run. */
const CONTRACTS_PRUNED = ["src", "tsconfig.json", "tsconfig.build.json"] as const;
/** Native addons the image builds for its own Node (`apps/vmd/src/dockerfile.ts`): the host's build names the builder's paths. */
const NATIVE_PRUNED = ["node-pty"] as const;
const TEST_FILE = /\.(?:test|spec)\.[^/\\]*$/;
const BUILDING = "packages/pi-host/.dist-agent-building";

const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

/**
 * Refuses a bundle that lacks a required file or a `node_modules`, or holds a link that is absolute, dangling or
 * resolves outside the bundle (T13a copies links as links, so a link out would read the builder's disk at build time).
 */
export const assertAgentBundle = (
  bundle: string,
  forbidden: readonly string[] = [],
  required: readonly string[] = REQUIRED_FILES,
): void => {
  for (const file of required)
    if (!existsSync(join(bundle, file)))
      throw new Error(`the agent bundle lacks ${file}: run pnpm build first`);
  if (!existsSync(join(bundle, "node_modules")))
    throw new Error("the agent bundle lacks node_modules: run pnpm build first");
  const root = realpathSync(bundle);
  const needles = forbidden.filter((text) => text.length > 1).map((text) => Buffer.from(text));
  for (const entry of readdirSync(bundle, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const shown = relative(bundle, path);
    if (TEST_FILE.test(entry.name)) throw new Error(`${shown} is a test file`);
    if (PNPM_STATE.some((name) => name === entry.name) || shown === "node_modules/@pap/contracts/src")
      throw new Error(`${shown} is builder state or a source folder`);
    if (entry.isFile() && needles.length > 0) {
      const bytes = readFileSync(path);
      if (needles.some((needle) => bytes.includes(needle)))
        throw new Error(`${shown} names the builder's home, the repository or the store`);
    }
    if (!entry.isSymbolicLink()) continue;
    if (isAbsolute(readlinkSync(path))) throw new Error(`${shown} is an absolute link`);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new Error(`${shown} is a link that does not resolve`);
    }
    if (!inside(root, real)) throw new Error(`${shown} is a link that leaves the bundle`);
  }
};

/**
 * Makes the deployed folder the same bytes whoever builds it and wherever: no pnpm state, no sources, no tests, and a
 * `package.json` without the dependency fields (they hold `file://` paths and peer suffixes; the tree is already flat).
 */
export const finishAgentBundle = (folder: string): void => {
  for (const name of PRUNED) rmSync(join(folder, name), { recursive: true, force: true });
  for (const name of PNPM_STATE) rmSync(join(folder, "node_modules", name), { force: true, recursive: true });
  for (const name of CONTRACTS_PRUNED)
    rmSync(join(folder, "node_modules/@pap/contracts", name), { recursive: true, force: true });
  for (const name of NATIVE_PRUNED)
    rmSync(join(folder, "node_modules", name), { recursive: true, force: true });
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true }))
    if (TEST_FILE.test(entry.name) && !entry.isDirectory())
      rmSync(join(entry.parentPath, entry.name), { force: true });
  const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as Record<string, unknown>;
  const { name, version, type, exports } = manifest;
  const keep = Object.fromEntries(
    Object.entries((exports ?? {}) as Record<string, Record<string, string>>).map(([key, value]) => [
      key,
      { default: value.default },
    ]),
  );
  writeFileSync(
    join(folder, "package.json"),
    `${JSON.stringify({ name, version, private: true, type, exports: keep }, null, 2)}\n`,
  );
};

export interface DeployProdOptions {
  repo: string;
  run: Runner;
  storeDir: string;
  /** The workspace package, e.g. `@pap/pi-host`. */
  filter: string;
  dest: string;
}

/** `pnpm deploy` of one workspace package: production dependencies, hoisted, copied from the local store, no network. */
export const deployProd = async ({ repo, run, storeDir, filter, dest }: DeployProdOptions): Promise<void> => {
  try {
    await run(
      "pnpm",
      [
        "--filter",
        filter,
        "deploy",
        "--prod",
        "--offline",
        "--package-import-method=copy",
        "--config.node-linker=hoisted",
        "--config.inject-workspace-packages=true",
        "--store-dir",
        storeDir,
        dest,
      ],
      repo,
    );
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "")
      .trim()
      .slice(-400);
    throw new Error(
      `pnpm deploy failed: the pnpm store at ${storeDir} may lack the packages, run pnpm install first${stderr === "" ? "" : ` (${stderr})`}`,
      { cause: error },
    );
  }
};

/**
 * `pnpm deploy` hardlinks the workspace's built files (contracts `dist`) into its output; a later build of the workspace
 * would rewrite the bundle in place. A copy gets new inodes, so no bundle file shares one with the workspace.
 */
export const copyUnlinked = (from: string, to: string): void => {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
};

export interface BuildAgentBundleOptions {
  repo: string;
  run: Runner;
  /** The local pnpm store: the deploy is offline and takes everything from it. */
  storeDir: string;
  out?: string;
}

/**
 * Deploys `@pap/pi-host` (production dependencies, hoisted, copied from the local store, no network) beside the final
 * folder, prunes it, checks it, and only then replaces `out`: a failure keeps the previous bundle.
 */
export const buildAgentBundle = async ({
  repo,
  run,
  storeDir,
  out,
}: BuildAgentBundleOptions): Promise<string> => {
  const target = out ?? join(repo, AGENT_BUNDLE);
  const building = out === undefined ? join(repo, BUILDING) : `${out}.building`;
  const deployed = `${building}.deploy`;
  rmSync(building, { recursive: true, force: true });
  rmSync(deployed, { recursive: true, force: true });
  try {
    await deployProd({ repo, run, storeDir, filter: "@pap/pi-host", dest: deployed });
    copyUnlinked(deployed, building);
    finishAgentBundle(building);
    assertAgentBundle(building, [homedir(), repo, storeDir]);
    rmSync(target, { recursive: true, force: true });
    renameSync(building, target);
    return target;
  } finally {
    rmSync(building, { recursive: true, force: true });
    rmSync(deployed, { recursive: true, force: true });
  }
};

const exec = promisify(execFile);

/**
 * `pnpm store path` answers the versioned store (`.../store/v11`) and `pnpm deploy --store-dir` appends the version again
 * (`v10/`), so the offline deploy finds no tarball. The deploy is given the store root: one trailing `/v<digits>` goes.
 */
export const storeRootOf = (storePath: string): string => storePath.replace(/\/v\d+\/?$/, "");

const main = async (): Promise<void> => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const storeDir = storeRootOf(
    (await exec("pnpm", ["store", "path"], { cwd: repo, timeout: 30_000 })).stdout.trim(),
  );
  const run: Runner = async (cmd, args, cwd) => {
    await exec(cmd, [...args], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  };
  const bundle = await buildAgentBundle({ repo, run, storeDir });
  console.log(`build-agent-bundle: wrote ${bundle}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`build-agent-bundle: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
