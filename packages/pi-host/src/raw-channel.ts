import type { DaemonToWorker } from "@pap/contracts/pi-host";
import type { Ipc } from "./ipc.ts";

/** Test only: the worker's channel to the daemon, which the scripted provider's raw `platform_call` steps use (a VM worker has no process IPC). */
export type RawChannel = Pick<Ipc, "send"> & {
  onMessage(listener: (record: DaemonToWorker) => void): unknown;
};

let channel: RawChannel | null = null;

/** Set by the host only beside `PAP_TEST_PROVIDER=1`; a production worker never holds one. */
export function setRawChannel(next: RawChannel): void {
  channel = next;
}
export const rawChannel = (): RawChannel | null => channel;

/** The process's own IPC channel, for a worker the daemon forks directly; null in a worker without one. */
export const processChannel = (): RawChannel | null =>
  process.send
    ? {
        send: (record) => process.send?.(record) ?? false,
        onMessage: (listener) => process.on("message", listener),
      }
    : null;
