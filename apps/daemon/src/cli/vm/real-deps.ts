import { execFile } from "node:child_process";
import { cpSync, createWriteStream, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CliError } from "../open-home.ts";
import { bundledAssets, parseAssets, type VmAsset } from "./assets.ts";
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

export function realDeps(): VmDeps {
  return {
    roots: REAL_ROOTS,
    exec,
    isRoot: process.getuid?.() === 0,
    copyTree: (source, destination) =>
      cpSync(source, destination, { recursive: true, verbatimSymlinks: true, force: true }),
    lookupUser,
    loadAssets: (file) =>
      file === undefined ? bundledAssets() : parseAssets(JSON.parse(readFileSync(file, "utf8"))),
    download,
    nodePath: process.execPath,
    treeRoot: findTree(),
  };
}
