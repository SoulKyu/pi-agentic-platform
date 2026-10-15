import { BranchName, PapError } from "@pap/contracts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { branchCandidates } from "./names.ts";

/** A git call that could not answer (timeout, no git, too much output) is `capacity`: the person retries later. */
function unanswered(error: unknown): never {
  if (error instanceof PapError) throw error;
  throw new PapError("capacity");
}

/** `check-ref-format --branch` must print the name back unchanged (an `@{-1}` would expand, M9R32). */
async function echoesUnchanged(git: GitRunner, root: string, name: string): Promise<boolean> {
  if (!BranchName.safeParse(name).success) return false;
  try {
    const { stdout } = await git.run(root, ["check-ref-format", "--branch", name]);
    return stdout.toString("utf8").replace(/\n$/, "") === name;
  } catch (error) {
    if (error instanceof GitError && error.kind === "failed") return false;
    return unanswered(error);
  }
}

async function resolves(git: GitRunner, root: string, ref: string): Promise<string | null> {
  try {
    const { stdout, code } = await git.run(root, ["rev-parse", "--verify", "--quiet", ref], {
      okCodes: [0, 1],
    });
    return code === 0 ? stdout.toString("utf8").trim() : null;
  } catch (error) {
    return unanswered(error);
  }
}

/** The branch of a new lane (M9R32): the given one, which must not exist, or the first free `<prefix><slug>[-2…-20]`. */
export async function chooseBranch(
  git: GitRunner,
  root: string,
  explicit: string | undefined,
  prefix: string,
  slug: string,
): Promise<string> {
  const exists = async (name: string): Promise<boolean> =>
    (await resolves(git, root, `refs/heads/${name}`)) !== null;
  if (explicit !== undefined) {
    if (!(await echoesUnchanged(git, root, explicit))) throw new PapError("bad_request");
    if (await exists(explicit)) throw new PapError("conflict");
    return explicit;
  }
  for (const name of branchCandidates(prefix, slug)) {
    if (!(await echoesUnchanged(git, root, name))) throw new PapError("bad_request");
    if (!(await exists(name))) return name;
  }
  throw new PapError("limit_reached");
}

/** The base of a new lane: the given ref, else the current branch, else HEAD's oid; resolved to a commit (M9R32). */
export async function resolveBase(
  git: GitRunner,
  root: string,
  given: string | undefined,
  current: string | null,
): Promise<{ baseRef: string; baseOid: string }> {
  const wanted = given ?? (current === null ? "HEAD" : `refs/heads/${current}`);
  const oid = await resolves(git, root, `${wanted}^{commit}`);
  if (oid === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new PapError("bad_request");
  return { baseRef: given ?? (current === null ? oid : wanted), baseOid: oid };
}
