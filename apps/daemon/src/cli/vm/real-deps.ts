import { execFile } from "node:child_process";
import {
  chownSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { CliError } from "../open-home.ts";
import { UNIT } from "../service/common.ts";
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

/**
 * Dev only: the release step's own deploy and pruning, loaded from the checkout. pnpm runs as the checkout's owner, never
 * root: root has no pnpm on its PATH, and a root pnpm would leave root-owned files in the owner's store. Root then copies
 * the result into place (pap-vmd itself still runs code the owner can change: the residual setup prints).
 */
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
  const { uid, gid } = statSync(tree);
  const home = readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .map((line) => line.split(":"))
    .find((fields) => Number(fields[2]) === uid)?.[5];
  if (home === undefined) throw new CliError(`the checkout's owner (uid ${uid}) has no passwd entry`);
  const corepack = join(dirname(process.execPath), "corepack");
  // ponytail: Node's own corepack runs the checkout's pinned pnpm; a Node without corepack falls back to pnpm on PATH.
  const command = (cmd: string, args: readonly string[]): [string, string[]] =>
    cmd === "pnpm" && existsSync(corepack) ? [corepack, ["pnpm", ...args]] : [cmd, [...args]];
  const asOwner = { uid, gid, env: { ...process.env, HOME: home, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } };
  const run = async (cmd: string, args: readonly string[], cwd: string): Promise<void> => {
    const [file, argv] = command(cmd, args);
    const result = await new Promise<{ code: number; stderr: string }>((done) =>
      execFile(
        file,
        argv,
        { cwd, timeout: 600_000, maxBuffer: 64 * 1024 * 1024, ...asOwner },
        (error, stdout, stderr) =>
          done({
            code: error === null ? 0 : typeof error.code === "number" ? error.code : 127,
            stderr: `${stderr}${stdout}`,
          }),
      ),
    );
    // The tail of the tool's output says why (a missing store, a pnpm that cannot start); a path in it is the owner's own.
    if (result.code !== 0)
      throw new CliError(
        `${cmd} ${args[0] ?? ""} failed (exit code ${result.code})${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim().slice(-400)}`}`,
      );
  };
  const [storeFile, storeArgs] = command("pnpm", ["store", "path"]);
  const storeDir = await new Promise<string>((done, fail) =>
    execFile(storeFile, storeArgs, { cwd: tree, timeout: 30_000, ...asOwner }, (error, stdout) =>
      error === null ? done(String(stdout).trim()) : fail(new CliError("pnpm store path failed")),
    ),
  );
  const building = mkdtempSync(join(tmpdir(), "pap-vmd-"));
  try {
    chownSync(building, uid, gid);
    await mod.buildVmdFolder({ repo: tree, run, storeDir }, join(building, "vmd"));
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(building, "vmd"), dest, { recursive: true, verbatimSymlinks: true });
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
}

/** I3: the files `sudo pap vm setup` trusts as root, resolved through links. */
export function codePaths(entry: string | undefined = process.argv[1]): string[] {
  const main = realpathSync(entry ?? "");
  return [
    main,
    dirname(main),
    realpathSync(fileURLToPath(new URL("./vm-assets.json", import.meta.url))),
    realpathSync(process.execPath),
  ];
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
    readMounts: () => readFileSync("/proc/self/mountinfo", "utf8"),
    nodePath: process.execPath,
    codePaths: () => codePaths(),
    statCode: (path) => statSync(path),
    readUserUnit: (userHome) => {
      try {
        return readFileSync(join(userHome, ".config/systemd/user", UNIT), "utf8");
      } catch {
        return null;
      }
    },
    treeRoot: findTree(),
  };
}
