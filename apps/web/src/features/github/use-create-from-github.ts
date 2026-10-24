import { RepoFullName } from "@pap/contracts";
import { usePendingAction } from "@pap/ui";
import { useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { holdProject } from "../../stores/shell-store.ts";
import { githubFailure } from "./github-errors.ts";

export type CreateMode = "clone" | "fork";

/**
 * `projects.createFromGithub` for the New project dialog: the repository is judged by the contract's own schema before any
 * call; `mode` is the button pressed (its spinner), a refusal stays as `problem` until the next attempt.
 */
export function useCreateFromGithub(onAdded: (projectId: string) => void) {
  const pending = usePendingAction();
  const [mode, setMode] = useState<CreateMode | null>(null);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const run = (repository: string, chosen: CreateMode) => {
    const parsed = RepoFullName.safeParse(repository.trim());
    if (!parsed.success) {
      setProblem("github.repo.invalid");
      return;
    }
    setMode(chosen);
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        const { project } = await rpc.call(
          "projects.createFromGithub",
          { repository: parsed.data, mode: chosen },
          { commandId: rpc.newCommandId() },
        );
        holdProject(project);
        onAdded(project.id);
      } catch (failure) {
        setProblem(githubFailure(failure, true));
      }
    });
  };
  return { since: pending.since, mode, problem, run, clear: () => setProblem(null) };
}
