import type { PtyCommand, PtyReport } from "@pap/contracts";
import type { BoxPtyChannel, BoxTerminals } from "../boxes.ts";

export interface FakeBoxPty {
  readonly channel: BoxPtyChannel;
  readonly sent: PtyCommand[];
  /** The guest sends output. */
  output(text: string | Buffer): void;
  /** The guest's shell ended. */
  exit(code: number | null, signal?: string | null): void;
  /** The connection ended without a `pty_exit`. */
  drop(): void;
  readonly closedByDaemon: boolean;
}

export function createFakeBoxPty(): FakeBoxPty {
  const sent: PtyCommand[] = [];
  let listener: ((report: PtyReport) => void) | undefined;
  let ended = false;
  let closedByDaemon = false;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const end = (): void => {
    ended = true;
    markClosed();
  };
  return {
    sent,
    get closedByDaemon() {
      return closedByDaemon;
    },
    channel: {
      send(command) {
        if (ended) return false;
        sent.push(command);
        return true;
      },
      onReport: (next) => void (listener = next),
      closed,
      close() {
        closedByDaemon = true;
        end();
      },
    },
    output: (text) => listener?.({ type: "pty_output", data: Buffer.from(text).toString("base64") }),
    exit: (code, signal = null) => listener?.({ type: "pty_exit", code, signal }),
    drop: end,
  };
}

/** Opens the given fake ptys in order; records what was asked. */
export function createFakeBoxTerminals(ptys: readonly FakeBoxPty[]): BoxTerminals & {
  readonly opened: Array<{ projectId: string; cwd: string; cols: number; rows: number }>;
  readonly touched: string[];
} {
  const opened: Array<{ projectId: string; cwd: string; cols: number; rows: number }> = [];
  const touched: string[] = [];
  return {
    opened,
    touched,
    open(projectId, input) {
      opened.push({ projectId, ...input });
      const next = ptys[opened.length - 1];
      if (!next) throw new Error("no fake pty left");
      return Promise.resolve(next.channel);
    },
    touch: (projectId) => void touched.push(projectId),
  };
}
