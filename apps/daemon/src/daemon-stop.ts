import { killAllWorkerGroups } from "./kernel/supervisor/worker.ts";

/** The parts the daemon stops, in order; each is the module's own stop. */
export interface DaemonStopParts {
  readonly m11: { stop(): void };
  readonly m10Late: { stop(): Promise<void> };
  readonly pi: { stopAll(): Promise<void> };
  readonly sessions: { shutdownAll(): Promise<void> };
  readonly lanes: { shutdown(): Promise<void> };
  readonly wk: { shutdown(): Promise<void> };
  /** The list of things to undo, in reverse: the overview's listeners and the sockets among them. */
  closeAll(): Promise<void>;
}

/** The daemon's `stop`: idempotent, the same promise for every call. */
export function stopOnce(parts: DaemonStopParts): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async () => {
      parts.m11.stop();
      await parts.m10Late.stop();
      // Each worker climbs its own ladder (shutdown request, SIGTERM, SIGKILL) and pi-host cleans up Pi's bash
      // trees on the way; SIGKILL to every group first would leak them (R104).
      await Promise.all([parts.pi.stopAll(), parts.sessions.shutdownAll(), parts.lanes.shutdown()]);
      await parts.wk.shutdown();
      killAllWorkerGroups();
      await parts.closeAll();
    })();
    return stopping;
  };
}
