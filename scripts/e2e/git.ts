// J03's seams (M13R39): a bare repository standing in for the forge's remote, and the `gh` stub folder.
//   origin of the project  https://github.com/test/repo.git   (so `parseRemote` and `forgeOf` say GitHub: "Create PR" exists)
//   $HOME/.gitconfig       url.file://<bare>.insteadOf = that URL (the push seam, allowed by PAP_TEST_GIT_PROTOCOLS=file)
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PapProcess } from "./daemon.ts";

export const FORGE_URL = "https://github.com/test/repo.git";
/** The folder holding the `gh` stub: first on the daemon's PATH (`unattendedEnv` keeps PATH, so the forge call finds it). */
export const GH_STUB_DIR = fileURLToPath(new URL("./stubs", import.meta.url));
/** Environment for `test.use({ papEnv })`: the seam for the push and the stub first on PATH. */
export const laneEnv = (): Record<string, string> => ({
  PAP_TEST_GIT_PROTOCOLS: "file",
  PATH: `${GH_STUB_DIR}:${process.env["PATH"] ?? ""}`,
});

const run = (pap: Pick<PapProcess, "userHome">, cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    env: { PATH: process.env["PATH"], HOME: pap.userHome, GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  });

/** Creates the bare remote beside the project, points `origin` at the forge URL and rewrites that URL to the bare one. */
export async function makeBareRemote(pap: Pick<PapProcess, "userHome" | "work">): Promise<string> {
  const bare = join(dirname(pap.work), "remote.git");
  run(pap, pap.work, "init", "-q", "--bare", "-b", "main", bare);
  run(pap, pap.work, "remote", "add", "origin", FORGE_URL);
  appendFileSync(join(pap.userHome, ".gitconfig"), `[url "file://${bare}"]\n\tinsteadOf = ${FORGE_URL}\n`);
  return bare;
}

/** `git` run in the bare remote or a worktree with the journey's HOME. */
export const gitIn = (pap: Pick<PapProcess, "userHome">, cwd: string, ...args: string[]): string =>
  run(pap, cwd, ...args);

/** What the stub logged: one `call <argv>` line per call, a `stdin <body>` line after a `pr create`. */
export function ghCalls(pap: Pick<PapProcess, "userHome">): string[] {
  const log = join(pap.userHome, "gh-calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}
