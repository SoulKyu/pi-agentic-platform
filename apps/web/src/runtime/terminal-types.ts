import type { Connection, Timers } from "./connection.ts";
import type { RpcClient } from "./rpc.ts";

export interface TerminalSink {
  attached(info: {
    start: number;
    end: number;
    cols: number;
    rows: number;
    status: "running" | "exited";
  }): void;
  reset(): void;
  /**
   * Resolves once the bytes are on screen (xterm's write callback): the channel acks from there. It must always
   * settle: a write that never does stalls the acks and every later attach. `reset()` is called as soon as the
   * frame arrives, so the sink orders it after its own queued writes (for example through its write queue).
   */
  output(bytes: Uint8Array, end: number): Promise<void>;
  exit(code: number | null, signal: string | null): void;
  /** `busy`: the server refused the attach for capacity; the screen decides when to ask again (it knows the store). */
  state(state: "attaching" | "live" | "offline" | "busy" | "gone"): void;
}
export interface TerminalHandle {
  /**
   * False when the stream is not attached (offline, hidden, gone) or the socket refused a frame. A long input is
   * several frames: false after a partial send means the earlier frames already went out.
   */
  input(data: Uint8Array): boolean;
  resize(cols: number, rows: number): void;
  close(): void;
}
export interface TerminalChannel {
  open(terminalId: string, sink: TerminalSink): TerminalHandle;
}

export interface PageVisibility {
  hidden(): boolean;
  onChange(listener: () => void): () => void;
}

export interface TerminalChannelDeps {
  readonly connection: Pick<Connection, "state" | "sendBinary" | "onBinary" | "onState">;
  readonly rpc: Pick<RpcClient, "call">;
  readonly timers: Timers;
  readonly visibility: PageVisibility;
}

/** How long a hidden page keeps its streams (M8R111); the server's stale rule covers the same 5 s (M8R57). */
export const HIDDEN_DETACH_MS = 5000;
/** Written bytes between two acks while the write queue stays busy (M8R69). */
export const ACK_EVERY_BYTES = 64 * 1024;
