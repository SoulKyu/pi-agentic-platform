import { DaemonToWorker } from "@pap/contracts";
import { logLineOf } from "./bounded.ts";

export type Outbound = { type: string } & Record<string, unknown>;

/**
 * The most JSON one record may carry. Node reads a record whole before the daemon's code sees any of it (it has no
 * receive-side limit), so a record this large costs the daemon several times its size in memory: it is stopped
 * here, where the size is known and the sender can still say so (R101). Nothing is capped below this on the way in:
 * a prompt, a pasted file or a tool result can be large, and only the events that grow with a whole run
 * (`agent_end.messages`, `turn_end.toolResults`) are cut earlier, by `toWireEvent`.
 */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

// Powers of two: the first drop is reported, then the 2nd, 4th, 8th…, so a message that keeps growing past the
// limit does not turn every update into a report.
const worthReporting = (count: number): boolean => (count & (count - 1)) === 0;

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
  let dropped = 0;
  // Called with a record that is too large to send: say so on stderr and to the daemon, in small records.
  const refuse = (record: Outbound, size: number, send: (small: Outbound) => void): void => {
    dropped++;
    const type = logLineOf(record.type).slice(0, 64);
    // A response is what the daemon is waiting for: it always gets one, however many records were dropped.
    if (record.type === "response" && typeof record.id === "string") {
      send({
        type: "response",
        // The whole id: the daemon matches the answer to its request by it, and it is the daemon's own short id.
        id: record.id,
        command: logLineOf(record.command).slice(0, 64),
        success: false,
        error: "record too large",
      });
    }
    if (!worthReporting(dropped)) return;
    proc.stderr.write(
      `pi-host: dropped a ${type} record of ${size} bytes: the limit is ${MAX_RECORD_BYTES}\n`,
    );
    if (record.type !== "response") {
      send({
        type: "extension_error",
        extensionPath: "pi-host:ipc",
        event: type,
        error: `a record of ${size} bytes was dropped: the limit is ${MAX_RECORD_BYTES}`,
      });
    }
  };
  const deliver = (record: Outbound): void => {
    try {
      const size = Buffer.byteLength(JSON.stringify(record));
      if (size > MAX_RECORD_BYTES) {
        refuse(record, size, deliver);
        return;
      }
      // False is also what a backed-up channel returns, and the record is still sent then: only a channel that
      // is no longer connected is a closed one.
      if (!send(record) && !proc.connected) markClosed();
    } catch (error) {
      proc.stderr.write(`pi-host: ipc send failed: ${logLineOf(error)}\n`);
    }
  };
  return {
    send: deliver,
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
