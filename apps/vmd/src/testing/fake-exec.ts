import type { Exec, ExecResult } from "../ops.ts";

/** A handler may print lines while "running" through `options.onLine`, as the streaming exec would. */
export type ExecHandler = (
  argv: readonly string[],
  options?: Parameters<Exec>[1],
) => Partial<ExecResult> | undefined | Promise<Partial<ExecResult> | undefined>;

export interface FakeExec {
  readonly exec: Exec;
  /** Every command line run, in order. */
  readonly calls: string[][];
  /** The `timeoutMs` each call in `calls` was given (undefined: the exec default). */
  readonly timeouts: (number | undefined)[];
}

/** A fake `exec`: records each argv and answers `{ code: 0, stdout: "", stderr: "" }` unless the handler says otherwise. */
export function createFakeExec(handler: ExecHandler = () => undefined): FakeExec {
  const calls: string[][] = [];
  const timeouts: (number | undefined)[] = [];
  return {
    calls,
    timeouts,
    exec: async (argv, options) => {
      calls.push([...argv]);
      timeouts.push(options?.timeoutMs);
      return { code: 0, stdout: "", stderr: "", ...(await handler(argv, options)) };
    },
  };
}
