import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bumpCatalog, choose, describeError, describePick } from "./pi-compat-bump.ts";

export interface Step {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function parseArgs(argv: readonly string[]): { readonly dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg !== "--dry-run") throw new Error(`pi-compat: unknown argument ${arg}`);
    dryRun = true;
  }
  return { dryRun };
}

export const worktreePath = (scratch: string): string => join(scratch, "tree");

// The commands around the catalog write: the worktree, then the checks inside it. Nothing runs in the repository
// after the worktree exists, so the owner's node_modules, workspace file and lockfile stay as they are.
export function planSteps(options: { repo: string; tree: string; heavyLock?: string | undefined }): Step[] {
  const { repo, tree, heavyLock } = options;
  const inTree = (command: string, ...args: string[]): Step => ({ command, args, cwd: tree });
  return [
    { command: "git", args: ["worktree", "add", "--detach", tree, "HEAD"], cwd: repo },
    inTree("pnpm", "install", "--no-frozen-lockfile"),
    inTree("pnpm", "typecheck"),
    inTree("pnpm", "test:unit"),
    heavyLock === undefined ? inTree("pnpm", "test:int") : inTree("flock", heavyLock, "pnpm", "test:int"),
  ];
}

// The version comes from the registry; the text it is written into is the worktree's own (HEAD), never the working copy's.
export function bumpWorktreeCatalog(tree: string, version: string): void {
  const path = join(tree, "pnpm-workspace.yaml");
  writeFileSync(path, bumpCatalog(readFileSync(path, "utf8"), version));
}

function run(step: Step): boolean {
  console.log(`pi-compat: ${[step.command, ...step.args].join(" ")}`);
  return spawnSync(step.command, step.args, { cwd: step.cwd, stdio: "inherit" }).status === 0;
}

async function main(): Promise<number> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const repo = resolve(import.meta.dirname, "..");
  const catalog = join(repo, "pnpm-workspace.yaml");
  const yaml = readFileSync(catalog, "utf8");
  let pick;
  try {
    pick = await choose(yaml, Date.now());
  } catch (error) {
    console.error(`pi-compat: ${describeError(error)}`);
    return 1;
  }
  console.log(describePick(pick));
  if (dryRun) return 0;

  const scratch = mkdtempSync(join(tmpdir(), "pap-pi-compat-"));
  const tree = worktreePath(scratch);
  const [create, ...checks] = planSteps({
    repo,
    tree,
    heavyLock: process.env["PAP_HEAVY_LOCK"] || undefined,
  });
  let created = false;
  try {
    if (create === undefined || !run(create)) return 1;
    created = true;
    bumpWorktreeCatalog(tree, pick.version);
    for (const step of checks) if (!run(step)) return 1;
    console.log(`pi-compat: ${pick.version} passes`);
    return 0;
  } finally {
    if (created) spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: repo, stdio: "inherit" });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
