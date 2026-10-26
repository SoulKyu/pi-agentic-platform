import type { BoxRef } from "@pap/contracts";
import { usePendingAction } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { agentBoxFailure, boxFailure } from "./box-errors.ts";

export type BoxLifeMethod = "projects.startBox" | "projects.restartBox" | "projects.rebuild";
type ProjectBoxRef = Extract<BoxRef, { kind: "project" }>;
interface BoxAction {
  readonly since: number | null;
  readonly problem: string | null;
  readonly run: () => void;
}

/**
 * One box action at a time (start, restart, rebuild): `since` feeds the button's `pendingSince` (§7.3), `problem` is the
 * daemon's code in words (what happened, what is intact, what to do) and stays until the next attempt.
 */
export function useBoxAction(method: "projects.startBox", box: BoxRef, onDone?: () => void): BoxAction;
export function useBoxAction(
  method: "projects.restartBox" | "projects.rebuild",
  box: ProjectBoxRef,
): BoxAction;
export function useBoxAction(method: BoxLifeMethod, box: BoxRef, onDone?: () => void): BoxAction {
  const t = useT();
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const run = () =>
    void pending.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        const commandId = rpc.newCommandId();
        if (box.kind === "agent") await rpc.call("agents.startBox", { agentId: box.id }, { commandId });
        else await rpc.call(method, { projectId: box.id }, { commandId });
        onDone?.();
      } catch (failure) {
        // A launch the person stopped is no failure: the button is idle again and nothing is said.
        if (!(failure instanceof RpcError && failure.code === "stopped"))
          setProblem(t(box.kind === "agent" ? agentBoxFailure(failure) : boxFailure(failure)));
      }
    });
  return { since: pending.since, problem, run };
}
