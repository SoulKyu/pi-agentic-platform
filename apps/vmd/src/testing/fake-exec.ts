import type { Exec, ExecResult } from "../ops.ts";

export type ExecHandler = (argv: readonly string[]) => Partial<ExecResult> | undefined;

export interface FakeExec {
  readonly exec: Exec;
  /** Every command line run, in order. */
  readonly calls: string[][];
}

/** A fake `exec`: records each argv and answers `{ code: 0, stdout: "", stderr: "" }` unless the handler says otherwise. */
export function createFakeExec(handler: ExecHandler = () => undefined): FakeExec {
  const calls: string[][] = [];
  return {
    calls,
    exec: (argv) => {
      calls.push([...argv]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "", ...handler(argv) });
    },
  };
}
