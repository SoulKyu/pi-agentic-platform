import { DaemonToWorker } from "@pap/contracts";

export type Outbound = { type: string } & Record<string, unknown>;

export interface Ipc {
  send(record: Outbound): void;
  /** `onMalformed` hears what did not parse (the raw value), so a caller can fail fast instead of waiting for it. */
  onMessage(listener: (record: DaemonToWorker) => void, onMalformed?: (raw: unknown) => void): () => void;
  onDisconnect(listener: () => void): void;
}

export function createIpc(proc: NodeJS.Process): Ipc {
  const send = proc.send?.bind(proc);
  if (!send) throw new Error("pi-host needs an IPC channel: start it with child_process.fork");
  return {
    send(record) {
      try {
        send(record);
      } catch (error) {
        proc.stderr.write(
          `pi-host: ipc send failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
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
      proc.once("disconnect", listener);
    },
  };
}
