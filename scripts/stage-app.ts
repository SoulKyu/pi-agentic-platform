import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertNoCredentials,
  assertNoStagePath,
  missingDist,
  stageTree,
  type Runner,
} from "./build-archive-stage.ts";

export interface StageAppOptions {
  repo: string;
  out: string;
  run: Runner;
  storeDir?: string;
}

/** The archive's staging recipe without the archive: the image and the archive hold the same tree (M6bR31a). */
export const stageApp = async ({ repo, out, run, storeDir }: StageAppOptions): Promise<void> => {
  const missing = missingDist(repo);
  if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}: run pnpm build first`);
  await stageTree({ repo, app: out, run, storeDir });
  assertNoCredentials(out);
  assertNoStagePath(out, out);
};

const spawnRunner: Runner = (cmd, args, cwd) =>
  new Promise((done, fail) => {
    const child = spawn(cmd, [...args], { cwd, stdio: "inherit", timeout: 900_000 });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`${cmd} ${args[0] ?? ""} failed (exit code ${code})`)),
    );
  });

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: { out: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.out) throw new Error("usage: stage-app.ts --out <dir>");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await stageApp({ repo, out: resolve(values.out), run: spawnRunner });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`stage-app: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
