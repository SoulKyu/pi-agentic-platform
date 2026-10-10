import { DaemonToWorker } from "@pap/contracts";
import { logLineOf } from "./bounded.ts";

export type Outbound = { type: string } & Record<string, unknown>;

export interface Ipc {
  send(record: Outbound): void;
  /** `onMalformed` hears what did not parse (the raw value), so a caller can fail fast instead of waiting for it. */
  onMessage(listener: (record: DaemonToWorker) => void, onMalformed?: (raw: unknown) => void): () => void;
  /** Called once, when the channel to the daemon is gone, however the worker found out. */
  onDisconnect(listener: () => void): void;
}

export function createIpc(proc: NodeJS.Process): Ipc {
  const send = proc.send?.bind(proc);
  if (!send) throw new Error("pi-host needs an IPC channel: start it with child_process.fork");
  const closedListeners: Array<() => void> = [];
  let closed = false;
  const markClosed = () => {
    if (closed) return;
    closed = true;
    for (const listener of closedListeners.splice(0)) listener();
  };
  // On a closed channel Node does not throw: process.send returns false and the process emits an
  // ERR_IPC_CHANNEL_CLOSED error later, which crashes a process that has no listener for it.
  proc.once("disconnect", markClosed);
  proc.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ERR_IPC_CHANNEL_CLOSED") markClosed();
    else proc.stderr.write(`pi-host: ipc error: ${logLineOf(error)}\n`);
  });
  return {
    send(record) {
      try {
        // False is also what a backed-up channel returns, and the record is still sent then: only a channel that
        // is no longer connected is a closed one.
        if (!send(record) && !proc.connected) markClosed();
      } catch (error) {
        proc.stderr.write(`pi-host: ipc send failed: ${logLineOf(error)}\n`);
      }
    },
    onMessage(listener, onMalformed) {
      const handler = (raw: unknown) => {
        const parsed = DaemonToWorker.safeParse(raw);
        if (parsed.success) {
          listener(parsed.data);
          return;
        }
        // Field names only: a rejected record may carry anything, and nothing of it belongs in a log.
        const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "<record>"))];
        proc.stderr.write(`pi-host: dropped a malformed record (fields: ${fields.slice(0, 8).join(", ")})\n`);
        onMalformed?.(raw);
      };
      proc.on("message", handler);
      return () => {
        proc.off("message", handler);
      };
    },
    onDisconnect(listener) {
      if (closed) listener();
      else closedListeners.push(listener);
    },
  };
}
