import { type GitRunner } from "./runner.ts";

/**
 * Whether a commit is the main checkout's HEAD or an ancestor of it: work the owner already has in their own line.
 * Ref names say nothing about whose code a commit is (`gh pr checkout` makes a local branch of someone else's remote
 * one), so this looks at lineage only. Anything else, an unmerged branch included, answers false.
 */
export async function isInHeadLineage(git: GitRunner, root: string, oid: string): Promise<boolean> {
  const { code } = await git.run(root, ["merge-base", "--is-ancestor", oid, "HEAD"], { okCodes: [0, 1] });
  return code === 0;
}
