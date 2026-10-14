import { vi } from "vitest";
import type { NodePty } from "../../../kernel/pty/load.ts";

/** One shell as node-pty hands it out: a test emits its output and ends it. */
export interface FakeChild {
  readonly pid: number;
  readonly file: string;
  readonly args: readonly string[];
  readonly options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly cols: number;
    readonly rows: number;
  };
  readonly written: string[];
  readonly resizes: Array<[number, number]>;
  readonly flow: string[];
  emit(text: string): void;
  end(exitCode: number, signal?: number): void;
  // The members node-pty's `IPty` has and `spawnPty` calls.
  onData(listener: (chunk: string | Buffer) => void): void;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
}

/** A stand-in for the `node-pty` module: every `spawn` makes a `FakeChild` with an unused pid. */
export function createFakeNodePty(firstPid = 2_000_000) {
  const children: FakeChild[] = [];
  const spawn = vi.fn((file: string, args: string[], options: FakeChild["options"]): FakeChild => {
    let data: (chunk: string | Buffer) => void = () => {};
    let exit: (value: { exitCode: number; signal?: number }) => void = () => {};
    const child: FakeChild = {
      pid: firstPid + children.length,
      file,
      args,
      options,
      written: [],
      resizes: [],
      flow: [],
      emit: (text) => data(Buffer.from(text)),
      end: (exitCode, signal) => exit(signal === undefined ? { exitCode } : { exitCode, signal }),
      onData: (listener) => void (data = listener),
      onExit: (listener) => void (exit = listener),
      write: (bytes) => void child.written.push(bytes.toString("utf8")),
      resize: (cols, rows) => void child.resizes.push([cols, rows]),
      pause: () => void child.flow.push("pause"),
      resume: () => void child.flow.push("resume"),
    };
    children.push(child);
    return child;
  });
  return { pty: { spawn } as unknown as NodePty, spawn, children };
}
