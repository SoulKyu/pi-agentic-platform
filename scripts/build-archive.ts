import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertNoStagePath, missingDist, stageTree, type Runner } from "./build-archive-stage.ts";

export type { Runner } from "./build-archive-stage.ts";

const exec = promisify(execFile);
const RELEASE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GLIBC = /^\d+\.\d+$/;
const NODE_VERSION = /^v24\.(\d+)\.\d+$/;
const MIN_NODE_MINOR = 14;
const TEMPLATE = "scripts/archive-install.sh.tpl";

export interface BuildOptions {
  repo: string;
  outDir: string;
  nodePath: string;
  releaseId: string;
  glibc: string;
  run: Runner;
  gitSha?: string;
  dirty?: boolean;
  allowDirty?: boolean;
  /** Seconds since the epoch stamped on every member and in BUILD_INFO.json: the commit time, or now when dirty. */
  epoch?: number;
  storeDir?: string;
}

export interface BuildResult {
  archive: string;
  installer: string;
  sha256: string;
}

const git = async (repo: string, args: string[]): Promise<string> =>
  (await exec("git", args, { cwd: repo, timeout: 30_000, maxBuffer: 1 << 20 })).stdout.trim();

const sha256File = (path: string): Promise<string> =>
  new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });

const checkNode = async (nodePath: string): Promise<{ version: string; license: string }> => {
  const { stdout } = await exec(nodePath, ["--version"], { timeout: 10_000 });
  const version = stdout.trim();
  const minor = Number(NODE_VERSION.exec(version)?.[1] ?? -1);
  if (minor < MIN_NODE_MINOR)
    throw new Error(`the archive needs Node v24.${MIN_NODE_MINOR} or newer 24.x, found ${version}`);
  const license = join(dirname(dirname(nodePath)), "LICENSE");
  if (!existsSync(license))
    throw new Error(`Node LICENSE not found at ${license}: use an official Node build`);
  return { version, license };
};

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/@@([A-Z0-9_]+)@@/g, (_whole, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`template placeholder @@${key}@@ has no value`);
    return value;
  });

/** Builds the self-contained linux-x64 archive and its installer pinned to the archive checksum (M6R20-R24). */
export const buildArchive = async (options: BuildOptions): Promise<BuildResult> => {
  const { repo, outDir, releaseId, glibc } = options;
  if (!RELEASE_ID.test(releaseId)) throw new Error("release id must match [A-Za-z0-9._-]{1,64}");
  if (!GLIBC.test(glibc)) throw new Error("glibc must look like <major>.<minor>");
  const dirty = options.dirty ?? (await git(repo, ["status", "--porcelain"])) !== "";
  if (dirty && !options.allowDirty)
    throw new Error("the tree has uncommitted changes: commit them or pass --allow-dirty");
  if (dirty && !releaseId.includes("-dirty"))
    throw new Error("a build of a dirty tree needs a release id that holds -dirty");
  const missing = missingDist(repo);
  if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}: run pnpm build first`);
  const node = await checkNode(options.nodePath);
  const template = readFileSync(join(repo, TEMPLATE), "utf8");
  const gitSha = options.gitSha ?? (await git(repo, ["rev-parse", "--short=7", "HEAD"]));
  const epoch = options.epoch ?? Math.floor(Date.now() / 1000);

  const name = `pap-${releaseId}-linux-x64.tar.gz`;
  const archive = join(outDir, name);
  const installer = join(outDir, `pap-install-${releaseId}.sh`);
  mkdirSync(outDir, { recursive: true });
  const stage = mkdtempSync(join(outDir, ".stage-"));
  try {
    const top = join(stage, `pap-${releaseId}`);
    mkdirSync(join(top, "node/bin"), { recursive: true });
    copyFileSync(options.nodePath, join(top, "node/bin/node"));
    chmodSync(join(top, "node/bin/node"), 0o755);
    copyFileSync(node.license, join(top, "node/LICENSE"));
    await stageTree({ repo, app: join(top, "app"), run: options.run, storeDir: options.storeDir });
    const info = {
      releaseId,
      builtAt: new Date(epoch * 1000).toISOString(),
      node: node.version,
      glibc,
      gitSha,
    };
    writeFileSync(join(top, "BUILD_INFO.json"), `${JSON.stringify(info, null, 2)}\n`);
    assertNoStagePath(top, stage);
    await exec(
      "tar",
      [
        "--mode=u+rwX,go+rX,go-w",
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        `--mtime=@${epoch}`,
        "-czf",
        archive,
        "-C",
        stage,
        `pap-${releaseId}`,
      ],
      { timeout: 600_000 },
    );
    const sha256 = await sha256File(archive);
    if (!SHA256.test(sha256)) throw new Error("computed checksum is not a sha-256");
    writeFileSync(`${archive}.sha256`, `${sha256}  ${name}\n`);
    writeFileSync(
      installer,
      fill(template, { SHA256: sha256, RELEASE_ID: releaseId, ARCHIVE_NAME: name, MIN_GLIBC: glibc }),
    );
    chmodSync(installer, 0o755);
    return { archive, installer, sha256 };
  } catch (error) {
    for (const file of [archive, `${archive}.sha256`, installer]) rmSync(file, { force: true });
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

const spawnRunner: Runner = (cmd, args, cwd) =>
  new Promise((done, fail) => {
    const child = spawn(cmd, [...args], { cwd, stdio: "inherit", timeout: 900_000 });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`${cmd} ${args[0] ?? ""} failed (exit code ${code})`)),
    );
  });

const stamp = (date: Date): string => date.toISOString().slice(0, 16).replace(/[-:T]/g, "");

const hostGlibc = async (): Promise<string> => {
  const { stdout } = await exec("getconf", ["GNU_LIBC_VERSION"], { timeout: 5_000 });
  const version = /(\d+\.\d+)/.exec(stdout)?.[1];
  if (!version) throw new Error("cannot read the glibc version: the archive targets linux-x64 with glibc");
  return version;
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: { out: { type: "string" }, "allow-dirty": { type: "boolean", default: false } },
    strict: true,
    allowPositionals: false,
  });
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dirty = (await git(repo, ["status", "--porcelain"])) !== "";
  const sha = await git(repo, ["rev-parse", "--short=7", "HEAD"]);
  const commitTime = Number(await git(repo, ["log", "-1", "--format=%ct"]));
  const manifest = JSON.parse(readFileSync(join(repo, "apps/daemon/package.json"), "utf8")) as {
    version: string;
  };
  const now = new Date();
  const releaseId = `${manifest.version}-${sha}${dirty ? "-dirty" : ""}-${stamp(now)}`;
  const storeDir = (await exec("pnpm", ["store", "path"], { cwd: repo, timeout: 30_000 })).stdout.trim();
  const started = Date.now();
  const result = await buildArchive({
    repo,
    outDir: resolve(values.out ?? join(repo, ".pap-archive")),
    nodePath: process.execPath,
    releaseId,
    glibc: await hostGlibc(),
    run: spawnRunner,
    gitSha: sha,
    dirty,
    allowDirty: values["allow-dirty"],
    epoch: dirty ? Math.floor(now.getTime() / 1000) : commitTime,
    storeDir,
  });
  console.log(`archive:   ${result.archive}\ninstaller: ${result.installer}\nsha256:    ${result.sha256}`);
  console.log(`built in ${Math.round((Date.now() - started) / 1000)} s`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`build-archive: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
