import { randomBytes } from "node:crypto";
import { type IssueView, LANE_LIMITS, PapError } from "@pap/contracts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { chooseBranch } from "./create-git.ts";
import { issuePrompt } from "./issue-prompt.ts";
import { laneIdOf } from "./names.ts";

/** A fan-out lane's branch ends in its slot's letter: `-a` to `-d` (M9R81). */
const SUFFIXES = ["a", "b", "c", "d"] as const;
const ID_TRIES = 8;

/**
 * The first prompt every lane of a group gets, and the text the group stores (M9R81, M9-RT-14): the fenced issue alone
 * for an issue (the caller's description never joins it, 18a), else the title and the description. A prompt past the
 * stored cap is refused, never cut: a cut fence would have no closing tag.
 */
export function renderedPrompt(input: {
  readonly title: string;
  readonly description: string;
  readonly issue?: IssueView | undefined;
}): string {
  const prompt =
    input.issue === undefined ? `# ${input.title}\n\n${input.description}` : issuePrompt(input.issue);
  if (prompt.length > LANE_LIMITS.fanoutPrompt) throw new PapError("bad_request");
  return prompt;
}

/** One branch per lane, each through the same checks as a single lane's (`chooseBranch`, M9R32). */
export async function chooseBranches(
  git: GitRunner,
  root: string,
  explicit: string | undefined,
  prefix: string,
  slug: string,
  count: number,
): Promise<string[]> {
  if (count === 1) return [await chooseBranch(git, root, explicit, prefix, slug)];
  const branches: string[] = [];
  for (const suffix of SUFFIXES.slice(0, count))
    branches.push(
      await chooseBranch(
        git,
        root,
        explicit === undefined ? undefined : `${explicit}-${suffix}`,
        prefix,
        `${slug}-${suffix}`,
      ),
    );
  return branches;
}

/** `count` lane ids no stored lane has, and none twice (the random digits can repeat inside one group). */
export function pickIds(
  count: number,
  title: string,
  exists: (id: string) => boolean,
  random?: (bytes: number) => Buffer,
): string[] {
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    let id = laneIdOf(title, random);
    for (let tries = 1; (exists(id) || ids.includes(id)) && tries < ID_TRIES; tries++)
      id = laneIdOf(title, random);
    ids.push(id);
  }
  return ids;
}

/** 16 random hex digits. */
export const newFanoutId = (random: (bytes: number) => Buffer = randomBytes): string =>
  random(8).toString("hex");
