import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PromptImageRef } from "@pap/contracts/pi-host";
import { logLineOf, messageOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";
import { type PromptImage, readPromptImages } from "./prompt-images.ts";
import type { PromptQueue } from "./prompt-queue.ts";

type Send = (record: Outbound) => void;
const logToStderr = (line: string) => process.stderr.write(line);

const clipId = (id: string) => id.slice(0, 64);

export function handlePrompt(
  session: AgentSession,
  command: { id: string; message: string; streamingBehavior?: "steer" | "followUp" | undefined },
  send: Send,
  images: readonly PromptImage[] = [],
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
      ...(images.length > 0 ? { images: [...images] } : {}),
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

/**
 * Puts a prompt in the worker's FIFO (M8R107): an image prompt reads its images first, and nothing behind it reaches Pi
 * before it does. An image that cannot be read refuses the whole prompt before Pi sees it.
 */
export function queuePrompt(
  queue: PromptQueue,
  session: AgentSession,
  papHome: string,
  command: {
    id: string;
    message: string;
    streamingBehavior?: "steer" | "followUp" | undefined;
    images?: readonly PromptImageRef[] | undefined;
  },
  send: Send,
  read: typeof readPromptImages = readPromptImages,
): void {
  const refuse = (error: string) =>
    send({ type: "response", id: command.id, command: "prompt", success: false, error });
  const wanted = command.images ?? [];
  if (wanted.length === 0) {
    queue.push({ start: () => handlePrompt(session, command, send, []), drop: () => refuse("pap:aborted") });
    return;
  }
  let images: PromptImage[] | null = null;
  queue.push({
    prepare: async () => {
      images = await read(papHome, wanted);
    },
    // Pi normalises images once more before it takes a prompt: whatever follows waits for its answer (M8R107).
    start: () =>
      new Promise<void>((settled, failed) => {
        if (images === null) {
          refuse("pap:image_unreadable");
          return settled();
        }
        const answering: Send = (record) => {
          try {
            send(record);
          } finally {
            if (record.type === "response" && record.id === command.id) settled();
          }
        };
        try {
          handlePrompt(session, command, answering, images);
        } catch (error) {
          failed(error);
        }
      }),
    drop: () => refuse("pap:aborted"),
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
