import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Outbound } from "./ipc.ts";

type Send = (record: Outbound) => void;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

export function handlePrompt(
  session: AgentSession,
  command: { id: string; message: string; streamingBehavior?: "steer" | "followUp" | undefined },
  send: Send,
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
    .catch((error: unknown) => answer({ success: false, error: messageOf(error) }));
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
