import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { BOX_GITHUB_RESULTS, type BoxOp } from "@pap/contracts/pi-host";
import { assertRemoteUrl, networkGit, privateConfigOf, publicKeyOf, signerOf } from "./github-env.ts";
import { runGit } from "./git-run.ts";
import { githubOf, type OpEnv, OpError } from "./paths.ts";

type Op<N extends BoxOp["name"]> = Extract<BoxOp, { name: N }>;

const text = (out: { stdout: Buffer }): string => out.stdout.toString("utf8").trim();

/** Keys of the repository's own config that would redirect a network call or hand the token elsewhere (the lane push path scans the same). */
const HOSTILE_CONFIG = [
  "config",
  "--null",
  "--show-scope",
  "--get-regexp",
  "^(core\\.(sshcommand|askpass|gitproxy)|credential\\..*|url\\..*\\.(insteadof|pushinsteadof)|http\\..*|remote\\..*\\.(vcs|proxy|receivepack|uploadpack|mirror|pushurl))$",
] as const;

/** A network call is refused (`conflict`) while the repository's own config holds such a key: the token goes only where github.com is. */
export async function assertCleanRemoteConfig(env: OpEnv): Promise<void> {
  const found = await runGit(env.project, HOSTILE_CONFIG, { okCodes: [0, 1] });
  // Entries are `scope NUL key LF value NUL`; the `command` scope is our own neutralising `-c` pairs.
  const parts = found.stdout.toString("utf8").split("\0");
  const hostile = parts.some((part, index) => index % 2 === 0 && part !== "" && part !== "command");
  if (hostile) throw new OpError("conflict");
}

/** The branch HEAD names (an unborn branch too); a detached HEAD has none and is refused. */
export async function currentBranch(env: OpEnv): Promise<string> {
  const out = await runGit(env.project, ["symbolic-ref", "--short", "-q", "HEAD"], { okCodes: [0, 1] });
  const parsed = BOX_GITHUB_RESULTS["git.push"].shape.branch.safeParse(text(out));
  if (!parsed.success) throw new OpError("conflict");
  return parsed.data;
}

async function hasRemote(env: OpEnv, name: string): Promise<boolean> {
  return (
    (await runGit(env.project, ["config", "--get", `remote.${name}.url`], { okCodes: [0, 1] })).code === 0
  );
}

async function setRemote(env: OpEnv, name: string, url: string): Promise<void> {
  await runGit(env.project, ["remote", (await hasRemote(env, name)) ? "set-url" : "add", name, url]);
}

async function removeRemote(env: OpEnv, name: string): Promise<void> {
  if (await hasRemote(env, name)) await runGit(env.project, ["remote", "remove", name]);
}

/** A project is empty for a clone when it holds nothing but the box's own `git init`, with no commit in it. */
async function assertEmptyProject(env: OpEnv): Promise<void> {
  const names = readdirSync(env.project);
  if (names.some((name) => name !== ".git")) throw new OpError("conflict");
  if (names.length === 0) return;
  if (!lstatSync(join(env.project, ".git")).isDirectory()) throw new OpError("conflict");
  const head = await runGit(env.project, ["rev-parse", "--verify", "-q", "HEAD"], { okCodes: [0, 1] });
  if (head.code === 0) throw new OpError("conflict");
}

const emptyProject = (env: OpEnv): void => {
  for (const name of readdirSync(env.project))
    rmSync(join(env.project, name), { recursive: true, force: true });
};

/** Clones into a folder beside the project (the box's disk) and moves it in only on success: a failed clone leaves `project/` as it was. */
export async function gitClone(env: OpEnv, op: Op<"git.clone">): Promise<unknown> {
  const deps = githubOf(env);
  for (const url of [op.url, ...(op.upstream === null ? [] : [op.upstream])]) assertRemoteUrl(deps, url);
  await assertEmptyProject(env);
  const temporary = join(dirname(env.project), `.clone-${randomBytes(8).toString("hex")}`);
  const staged: OpEnv = { ...env, project: temporary };
  try {
    await runGit(env.project, ["clone", "--", op.url, temporary], networkGit(deps, "git.clone"));
    if (op.upstream !== null) await setRemote(staged, "upstream", op.upstream);
    const branch = await currentBranch(staged);
    emptyProject(env);
    try {
      for (const name of readdirSync(temporary)) renameSync(join(temporary, name), join(env.project, name));
    } catch (error) {
      emptyProject(env);
      await runGit(env.project, ["init", "-q", "-b", "main"]).catch(() => undefined);
      throw error;
    }
    return { branch };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function gitLink(env: OpEnv, op: Op<"git.link">): Promise<unknown> {
  assertRemoteUrl(githubOf(env), op.url);
  await setRemote(env, "origin", op.url);
  return { ok: true };
}

export async function gitUnlink(env: OpEnv): Promise<unknown> {
  await removeRemote(env, "origin");
  await removeRemote(env, "upstream");
  return { ok: true };
}

/**
 * The commit's identity and signing, from the box's private config that `github.identity` wrote (never the home's file, which a
 * session edits). These commits run without a global config, so the signing settings go on the command line, with the guest's
 * run folder for the signer to find the agent's socket.
 */
async function commitOptions(env: OpEnv): Promise<{ config: string[]; env: Record<string, string> }> {
  const deps = githubOf(env);
  const file = privateConfigOf(deps);
  const read = async (key: string): Promise<string> =>
    text(await runGit(env.project, ["config", "--file", file, "--get", key], { okCodes: [0, 1] }));
  const [name, email] = [await read("user.name"), await read("user.email")];
  if (name === "" || email === "") throw new OpError("conflict");
  const signed = (await read("commit.gpgsign")) === "true";
  return {
    config: [
      `user.name=${name}`,
      `user.email=${email}`,
      ...(signed
        ? [
            "gpg.format=ssh",
            `user.signingkey=${publicKeyOf(deps)}`,
            `gpg.ssh.program=${signerOf(deps)}`,
            "commit.gpgsign=true",
          ]
        : ["commit.gpgsign=false"]),
    ],
    env: { PAP_GUEST_RUN_DIR: deps.runDir },
  };
}

/** `add -A`, then a commit; `{sha: null}` when nothing changed. */
export async function gitCommit(env: OpEnv, op: Op<"git.commit">): Promise<unknown> {
  const options = await commitOptions(env);
  await runGit(env.project, ["add", "-A"]);
  const staged = await runGit(env.project, ["diff", "--cached", "--quiet"], { okCodes: [0, 1] });
  if (staged.code === 0) return { sha: null };
  await runGit(env.project, ["commit", "-q", "-m", op.message], options);
  return { sha: text(await runGit(env.project, ["rev-parse", "HEAD"])) };
}

/** Pushes the current branch to `origin` and tracks it. */
export async function gitPush(env: OpEnv): Promise<unknown> {
  await assertCleanRemoteConfig(env);
  const branch = await currentBranch(env);
  const ref = `refs/heads/${branch}`;
  await runGit(
    env.project,
    ["push", "--set-upstream", "origin", `${ref}:${ref}`],
    networkGit(githubOf(env), "git.push"),
  );
  return { branch, remote: "origin" };
}
