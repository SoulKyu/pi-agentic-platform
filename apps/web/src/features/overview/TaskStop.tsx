import "../../i18n/register-overview.ts";
import { Button, InlineError, usePendingAction } from "@pap/ui";
import { useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

/** STOP on a task's line: `automation.tasks.cancel`, at once (a task can be retried, so no dialog). */
export function TaskStop({ taskId }: { readonly taskId: string }) {
  const t = useT();
  const pending = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const stop = () =>
    void pending.run(async () => {
      setProblem(null);
      try {
        const { rpc } = getRuntime();
        await rpc.call("automation.tasks.cancel", { taskId }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });
  return (
    <span data-task-stop="" className="flex flex-col items-end gap-s1">
      <Button variant="secondary" size="sm" pendingSince={pending.since} onClick={stop}>
        {t("overview.stop")}
      </Button>
      {problem === null ? null : <InlineError announce="action">{problem}</InlineError>}
    </span>
  );
}
