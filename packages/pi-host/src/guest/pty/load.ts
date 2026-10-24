import { createRequire } from "node:module";

/** The slice of a node-pty process the guest uses; its data is raw bytes (`encoding: null`). */
export interface PtyChild {
  readonly pid: number;
  onData(listener: (chunk: Buffer) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly encoding: null;
  readonly handleFlowControl: false;
}

export interface NodePty {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyChild;
}

const require = createRequire(import.meta.url);

/**
 * node-pty is a native addon: in the image it sits in `/opt/pap/pi-host/node_modules` (built for the image's Node), under
 * the process backend it is the repository's own install. A missing build answers null, never throws: the terminal is refused
 * and the rest of the guest runs on.
 */
export function loadNodePty(): NodePty | null {
  try {
    return require("node-pty") as NodePty;
  } catch {
    return null;
  }
}
