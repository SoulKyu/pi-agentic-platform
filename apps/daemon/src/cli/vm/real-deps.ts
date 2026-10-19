import { execFile } from "node:child_process";
import { cpSync, createWriteStream, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { CliError } from "../open-home.ts";
import { bundledAssets, openNoFollow, type VmAsset } from "./assets.ts";
import { REAL_ROOTS, type Exec, type VmDeps, type VmUser } from "./deps.ts";

const exec: Exec = (cmd, args) =>
  new Promise((done) => {
    execFile(cmd, [...args], { timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
      done({ code, stdout: String(stdout) });
    });
  });

const MAX_ASSET_BYTES = 4 * 1024 ** 3;

async function download(asset: VmAsset, dest: string): Promise<void> {
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(1_800_000) });
  if (!response.ok || response.body === null)
    throw new CliError(`${asset.name}: download failed (${response.status})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_ASSET_BYTES) throw new CliError(`${asset.name}: download too large`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest, { mode: 0o600 }));
}

function lookupUser(name: string): VmUser | undefined {
  for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
    const [user, , uid, gid, , home] = line.split(":");
    if (user === name && uid !== undefined && gid !== undefined && home !== undefined)
      return { uid: Number(uid), gid: Number(gid), home };
  }
  return undefined;
}

/** The checkout above this file (a folder with `pnpm-workspace.yaml`), or undefined for an installed pap. */
function findTree(): string | undefined {
  for (let dir = import.meta.dirname; dir !== dirname(dir); dir = dirname(dir))
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
  return undefined;
}

/** Dev only: the release step's own deploy and pruning, loaded from the checkout, run as root (the residual setup prints). */
async function deployVmd(tree: string, dest: string): Promise<void> {
  const mod = (await import(pathToFileURL(join(tree, "scripts/release-vm-assets.ts")).href)) as {
    buildVmdFolder: (
      o: {
        repo: string;
        run: (cmd: string, args: readonly string[], cwd: string) => Promise<void>;
        storeDir: string;
      },
      dest: string,
    ) => Promise<void>;
  };
  const run = async (cmd: string, args: readonly string[], cwd: string): Promise<void> => {
    const result = await new Promise<number>((done) =>
      execFile(cmd, [...args], { cwd, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }, (error) =>
        done(error === null ? 0 : typeof error.code === "number" ? error.code : 127),
      ),
    );
    if (result !== 0) throw new CliError(`${cmd} ${args[0] ?? ""} failed (exit code ${result})`);
  };
  const storeDir = await new Promise<string>((done, fail) =>
    execFile("pnpm", ["store", "path"], { cwd: tree, timeout: 30_000 }, (error, stdout) =>
      error === null ? done(String(stdout).trim()) : fail(new CliError("pnpm store path failed")),
    ),
  );
  await mod.buildVmdFolder({ repo: tree, run, storeDir }, dest);
}

export function realDeps(): VmDeps {
  return {
    roots: REAL_ROOTS,
    exec,
    isRoot: process.getuid?.() === 0,
    copyTree: (source, destination) =>
      cpSync(source, destination, { recursive: true, verbatimSymlinks: true, force: true }),
    lookupUser,
    compiled: bundledAssets(),
    openFile: openNoFollow,
    deployVmd,
    download,
    nodePath: process.execPath,
    treeRoot: findTree(),
  };
}
