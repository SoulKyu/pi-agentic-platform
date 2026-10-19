import { execFile } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Runner } from "./build-archive-stage.ts";

/** pi-host's `dist` plus a flat production `node_modules`: what the base image of the agent VMs is built from (T14b). */
export const AGENT_BUNDLE = "packages/pi-host/dist-agent";
/** What the guest and the relay start from; a bundle without them builds an image that cannot boot. */
export const REQUIRED_FILES = ["dist/guest/main.js", "dist/relay/main.js", "package.json"] as const;
/** `pnpm deploy` copies these beside `dist`; the image needs none of them. */
const PRUNED = ["src", "tsconfig.json", "tsconfig.build.json", "pnpm-lock.yaml"] as const;
const BUILDING = "packages/pi-host/.dist-agent-building";

const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

/**
 * Refuses a bundle that lacks a required file or a `node_modules`, or holds a link that is absolute, dangling or
 * resolves outside the bundle (T13a copies links as links, so a link out would read the builder's disk at build time).
 */
export const assertAgentBundle = (bundle: string): void => {
  for (const file of REQUIRED_FILES)
    if (!existsSync(join(bundle, file)))
      throw new Error(`the agent bundle lacks ${file}: run pnpm build first`);
  if (!existsSync(join(bundle, "node_modules")))
    throw new Error("the agent bundle lacks node_modules: run pnpm build first");
  const root = realpathSync(bundle);
  for (const entry of readdirSync(bundle, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const path = join(entry.parentPath, entry.name);
    const shown = relative(bundle, path);
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
  rmSync(building, { recursive: true, force: true });
  try {
    try {
      await run(
        "pnpm",
        [
          "--filter",
          "@pap/pi-host",
          "deploy",
          "--prod",
          "--offline",
          "--package-import-method=copy",
          "--config.node-linker=hoisted",
          "--config.inject-workspace-packages=true",
          "--store-dir",
          storeDir,
          building,
        ],
        repo,
      );
    } catch {
      throw new Error(
        `pnpm deploy failed: the pnpm store at ${storeDir} lacks the packages, run pnpm install first`,
      );
    }
    for (const name of PRUNED) rmSync(join(building, name), { recursive: true, force: true });
    assertAgentBundle(building);
    rmSync(target, { recursive: true, force: true });
    renameSync(building, target);
    return target;
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
};

const exec = promisify(execFile);

const main = async (): Promise<void> => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const storeDir = (await exec("pnpm", ["store", "path"], { cwd: repo, timeout: 30_000 })).stdout.trim();
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
