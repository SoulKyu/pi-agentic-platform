import { SERVER_CODES, type ServerText } from "@pap/contracts";

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

export function describeExit(exit: WorkerExit): ServerText {
  switch (exit.cause) {
    case "clean":
      return { text: "Agent process stopped.", code: SERVER_CODES.processStopped };
    case "exit_code": {
      const code = String(exit.code ?? "unknown");
      return {
        text: `Agent process exited with code ${code}.`,
        code: SERVER_CODES.processExitCode,
        params: { code },
      };
    }
    case "signal":
      return exit.signal
        ? {
            text: `Agent process stopped by ${exit.signal}.`,
            code: SERVER_CODES.processSignal,
            params: { signal: exit.signal },
          }
        : { text: "Agent process stopped by a signal.", code: SERVER_CODES.processSignalUnknown };
    case "killed":
      return {
        text: "Agent process killed (SIGKILL), possibly out of memory.",
        code: SERVER_CODES.processKilled,
      };
    case "oom":
      return { text: "Agent process ran out of memory and was stopped.", code: SERVER_CODES.processOom };
    case "spawn_failure":
      return { text: "Agent process could not start.", code: SERVER_CODES.processSpawnFailure };
  }
}
