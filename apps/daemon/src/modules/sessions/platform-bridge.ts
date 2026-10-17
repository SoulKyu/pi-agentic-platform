import { type PlatformResultRecord, SecretUsedRecord } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { AgentSurface } from "./agent-surface.ts";
import type { SessionRow } from "./store.ts";

/**
 * A second listener on a worker's handle, beside the live session's (M11R37): the worker's `platform_call` and
 * `platform_cancel` go to the platform dispatcher with the session's row, and its answers go back with `handle.send`.
 * Its `secret_used` (Task 18) tells the agents module, by the session's own id, that a one-use value was consumed.
 * The port is read at each record, so one set after the worker started is used. A throw is logged (the error class
 * alone) and never reaches the session.
 */
export function bridgePlatform(
  handle: Pick<WorkerHandle, "onRecord" | "send" | "exited">,
  row: SessionRow,
  agent: Pick<AgentSurface, "platform" | "secretUsed">,
  logger: Logger,
): void {
  const reply = (result: PlatformResultRecord) => handle.send(result);
  const guarded = (work: () => void): void => {
    try {
      work();
    } catch (error) {
      logger.warn("platform_bridge_failed", {
        sessionId: row.id,
        errorClass: error instanceof Error ? error.constructor.name : "non_error",
      });
    }
  };
  // A worker that is gone answers nobody: its calls in flight end.
  void handle.exited.then(() => guarded(() => agent.platform()?.workerEnded(row, reply)));
  handle.onRecord((record) => {
    if (record.type === "secret_used") {
      const used = SecretUsedRecord.safeParse(record);
      if (used.success) guarded(() => agent.secretUsed(row.id, used.data.id));
      return;
    }
    if (record.type !== "platform_call" && record.type !== "platform_cancel") return;
    guarded(() => agent.platform()?.onRecord(row, record, reply));
  });
}
