import { usePendingAction } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { boxFailure } from "./box-errors.ts";

export type BoxLifeMethod = "projects.startBox" | "projects.restartBox" | "projects.rebuild";

/**
 * One box action at a time (start, restart, rebuild): `since` feeds the button's `pendingSince` (§7.3), `problem` is the
 * daemon's code in words (what happened, what is intact, what to do) and stays until the next attempt.
 */
export function useBoxAction(method: BoxLifeMethod, projectId: string) {
  const t = useT();
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const run = () =>
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        await rpc.call(method, { projectId }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        setProblem(t(boxFailure(failure)));
      }
    });
  return { since: pending.since, problem, run };
}
