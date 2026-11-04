import type { BoxRef } from "@pap/contracts";
import { usePendingAction } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { agentBoxFailure, boxFailure, stopFailure } from "./box-errors.ts";

export type BoxLifeMethod =
  "projects.startBox" | "projects.stopBox" | "projects.restartBox" | "projects.rebuild";
type ProjectBoxRef = Extract<BoxRef, { kind: "project" }>;
export interface BoxAction {
  readonly since: number | null;
  readonly problem: string | null;
  readonly run: () => void;
  /** The call itself, for a caller with its own pending state and error place (a dialog): the problem in words, or null. */
  readonly attempt: () => Promise<string | null>;
}

/**
 * One box action at a time (start, stop, restart, rebuild): `since` feeds the button's `pendingSince` (§7.3), `problem` is the
 * daemon's code in words (what happened, what is intact, what to do) and stays until the next attempt.
 */
export function useBoxAction(
  method: "projects.startBox" | "projects.stopBox",
  box: BoxRef,
  onDone?: () => void,
): BoxAction;
export function useBoxAction(
  method: "projects.restartBox" | "projects.rebuild",
  box: ProjectBoxRef,
): BoxAction;
export function useBoxAction(method: BoxLifeMethod, box: BoxRef, onDone?: () => void): BoxAction {
  const t = useT();
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const stop = method === "projects.stopBox";
  const attempt = async (): Promise<string | null> => {
    const { rpc } = getRuntime();
    try {
      const commandId = rpc.newCommandId();
      if (box.kind === "agent")
        await rpc.call(stop ? "agents.stopBox" : "agents.startBox", { agentId: box.id }, { commandId });
      else await rpc.call(method, { projectId: box.id }, { commandId });
      onDone?.();
      return null;
    } catch (failure) {
      // A launch the person stopped is no failure: the button is idle again and nothing is said.
      if (failure instanceof RpcError && failure.code === "stopped") return null;
      if (stop) return t(stopFailure(failure));
      return t(box.kind === "agent" ? agentBoxFailure(failure) : boxFailure(failure));
    }
  };
  const run = () =>
    void pending.run(async () => {
      setProblem(null);
      setProblem(await attempt());
    });
  return { since: pending.since, problem, run, attempt };
}
