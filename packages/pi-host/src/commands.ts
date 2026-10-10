import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { logLineOf, messageOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";

type Send = (record: Outbound) => void;
const logToStderr = (line: string) => process.stderr.write(line);

const clipId = (id: string) => id.slice(0, 64);

export function handlePrompt(
  session: AgentSession,
  command: { id: string; message: string; streamingBehavior?: "steer" | "followUp" | undefined },
  send: Send,
  log: (line: string) => void = logToStderr,
): void {
  let answered = false;
  const answer = (fields: Record<string, unknown>) => {
    if (answered) return;
    answered = true;
    send({ type: "response", id: command.id, command: "prompt", ...fields });
  };
  session
    .prompt(command.message, {
      ...(command.streamingBehavior ? { streamingBehavior: command.streamingBehavior } : {}),
      preflightResult: (disposition) => answer({ success: true, data: { disposition } }),
    })
    .then(() => answer({ success: true, data: { disposition: "handled" } }))
    .catch((error: unknown) => {
      // The daemon already has its answer, so a failure after it can only be logged.
      if (answered)
        log(`pi-host: prompt ${clipId(command.id)} failed after it was accepted: ${logLineOf(error)}\n`);
      else answer({ success: false, error: messageOf(error) });
    });
}

export async function handleAbort(session: AgentSession, command: { id: string }, send: Send): Promise<void> {
  try {
    await session.abort();
    send({ type: "response", id: command.id, command: "abort", success: true });
  } catch (error) {
    send({ type: "response", id: command.id, command: "abort", success: false, error: messageOf(error) });
  }
}

export function handleGetState(session: AgentSession, command: { id: string }, send: Send): void {
  send({
    type: "response",
    id: command.id,
    command: "get_state",
    success: true,
    data: {
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      pendingMessageCount: session.pendingMessageCount,
      sessionFile: session.sessionFile ?? "",
      sessionId: session.sessionId,
    },
  });
}
