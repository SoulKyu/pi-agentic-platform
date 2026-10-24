import { usePendingAction } from "@pap/ui";
import { useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { githubFailure } from "./github-errors.ts";

/**
 * One GitHub action at a time: `since` feeds the button's `pendingSince` (§7.3); a refusal becomes `problem`, the
 * daemon's code in words, until the next attempt. `repository` words a `not_found` as the repository.
 */
export function useGithubAction(repository = false) {
  const pending = usePendingAction();
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const run = (work: () => Promise<void>) =>
    void pending.run(async () => {
      setProblem(null);
      try {
        await work();
      } catch (failure) {
        setProblem(githubFailure(failure, repository));
      }
    });
  return { since: pending.since, problem, run, clear: () => setProblem(null) };
}
