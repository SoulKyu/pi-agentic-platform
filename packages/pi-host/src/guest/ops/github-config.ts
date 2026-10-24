import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { boxPrivateOf, type GithubDeps, privateConfigOf } from "./github-env.ts";
import { readHomeFile, writeHomeFile } from "./github-home.ts";
import { runGit } from "./git-run.ts";
import type { OpEnv } from "./paths.ts";

/** A setting: the key, then its values in order; no value removes the key. */
export type ConfigEntry = readonly [key: string, ...values: string[]];

async function edit(env: OpEnv, file: string, entries: readonly ConfigEntry[]): Promise<void> {
  for (const [key, ...values] of entries) {
    if (values.length === 0) {
      await runGit(env.project, ["config", "--file", file, "--unset-all", key], { okCodes: [0, 5] });
      continue;
    }
    for (const [index, value] of values.entries())
      await runGit(env.project, [
        "config",
        "--file",
        file,
        index === 0 ? "--replace-all" : "--add",
        key,
        value,
      ]);
  }
}

const ensurePrivateFolder = (deps: GithubDeps): void => {
  mkdirSync(boxPrivateOf(deps), { recursive: true, mode: 0o700 });
};

/**
 * Changes the home's `.gitconfig` without following a link a session planted there: the file is read without following,
 * edited as a copy in the box's guest-only folder and written back by rename (the session's other settings stay).
 */
export async function editHomeConfig(
  env: OpEnv,
  deps: GithubDeps,
  entries: readonly ConfigEntry[],
): Promise<void> {
  ensurePrivateFolder(deps);
  const scratch = `${boxPrivateOf(deps)}/scratch-${randomBytes(8).toString("hex")}.gitconfig`;
  try {
    writeFileSync(scratch, readHomeFile(deps.home, ".gitconfig") ?? "", { mode: 0o600, flag: "wx" });
    await edit(env, scratch, entries);
    writeHomeFile(deps.home, null, ".gitconfig", readFileSync(scratch), 0o644);
  } finally {
    rmSync(scratch, { force: true });
  }
}

/** The same entries in the box's private config, which the daemon-initiated commits read instead of the home's file. */
export async function editPrivateConfig(
  env: OpEnv,
  deps: GithubDeps,
  entries: readonly ConfigEntry[],
): Promise<void> {
  ensurePrivateFolder(deps);
  await edit(env, privateConfigOf(deps), entries);
}
