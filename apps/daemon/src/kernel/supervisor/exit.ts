export type ExitCause = "clean" | "exit_code" | "signal" | "killed" | "oom" | "spawn_failure";

export interface WorkerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cause: ExitCause;
}

export function classifyExit(code: number | null, signal: NodeJS.Signals | null): WorkerExit {
  if (signal === "SIGKILL") return { code, signal, cause: "killed" };
  if (signal) return { code, signal, cause: "signal" };
  return { code, signal, cause: code === 0 ? "clean" : "exit_code" };
}

export function describeExit(exit: WorkerExit): string {
  switch (exit.cause) {
    case "clean":
      return "Agent process stopped.";
    case "exit_code":
      return `Agent process exited with code ${exit.code ?? "unknown"}.`;
    case "signal":
      return `Agent process stopped by ${exit.signal ?? "a signal"}.`;
    case "killed":
      return "Agent process killed (SIGKILL), possibly out of memory.";
    case "oom":
      return "Agent process ran out of memory and was stopped.";
    case "spawn_failure":
      return "Agent process could not start.";
  }
}
