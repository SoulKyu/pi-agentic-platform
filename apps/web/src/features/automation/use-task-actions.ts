import type { TaskView } from "@pap/contracts";
import { usePendingAction } from "@pap/ui";
import { useState } from "react";
import { useStepUpRunner } from "../../lib/step-up-context.tsx";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { actionErrorText, type FailingAction, type TaskAction } from "./board.vm.ts";

const codeOf = (failure: unknown): string => (failure instanceof RpcError ? failure.code : "internal");

export interface TaskActions {
  /** The button whose call is in flight, and when it started (for `Button.pendingSince`); one call at a time. */
  readonly active: TaskAction | null;
  readonly since: number | null;
  /** The fixed text of the last refusal, or null. */
  readonly error: string | null;
  cancel(): void;
  retry(): void;
  resumeNow(): void;
  releaseTools(): void;
}

/**
 * The calls behind a card's buttons. Each is a mutation with its own `commandId`; none is sent again after an unknown
 * outcome (R105). "Use my normal tools" goes through the shell's password step-up (owner m10a7).
 */
export function useTaskActions(task: TaskView): TaskActions {
  const stepUp = useStepUpRunner();
  const pending = usePendingAction();
  const [active, setActive] = useState<TaskAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const perform = (action: TaskAction, failing: FailingAction, job: () => Promise<unknown>) =>
    void pending.run(async () => {
      setActive(action);
      setError(null);
      try {
        await job();
      } catch (failure) {
        setError(actionErrorText(failing, codeOf(failure)));
      } finally {
        setActive(null);
      }
    });

  const rpc = () => getRuntime().rpc;
  const withTask = (method: "automation.tasks.cancel" | "automation.tasks.retry") => () =>
    rpc().call(method, { taskId: task.id }, { commandId: rpc().newCommandId() });
  const withSession = (method: "usage.resumeNow") => async () => {
    if (task.sessionId === null) return;
    await rpc().call(method, { sessionId: task.sessionId }, { commandId: rpc().newCommandId() });
  };

  // The row can leave (the 30-day rule) while the session keeps its list: then the session is the key (carry from 5b).
  const release = () =>
    stepUp(async (commandId) => {
      try {
        return await rpc().call("automation.tasks.releaseTools", { taskId: task.id }, { commandId });
      } catch (failure) {
        if (codeOf(failure) !== "not_found" || task.sessionId === null) throw failure;
        return rpc().call(
          "automation.tasks.releaseTools",
          { sessionId: task.sessionId },
          { commandId: rpc().newCommandId() },
        );
      }
    });

  return {
    active,
    since: pending.since,
    error,
    cancel: () => perform("cancel", "cancel", withTask("automation.tasks.cancel")),
    retry: () => perform("retry", "retry", withTask("automation.tasks.retry")),
    resumeNow: () => perform("resumeNow", "resumeNow", withSession("usage.resumeNow")),
    releaseTools: () => perform("releaseTools", "releaseTools", release),
  };
}
