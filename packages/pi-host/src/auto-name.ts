import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { messageOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";
import { buildTitleTranscript, parseTitle, TITLE_PROMPT, TITLE_SYSTEM_PROMPT } from "./title.ts";

const TITLE_TIMEOUT_MS = 90_000;
const TITLE_MAX_TOKENS = 256;

type Send = (record: Outbound) => unknown;

/**
 * One request with the session's model and credentials, outside the conversation: a short system prompt, one user
 * turn, no tools, the cheapest reasoning level. The title becomes the session's name through Pi itself.
 */
export async function handleAutoName(
  session: AgentSession,
  command: { id: string },
  send: Send,
): Promise<void> {
  const answer = (fields: Record<string, unknown>) =>
    send({ type: "response", id: command.id, command: "auto_name", ...fields });
  const model = session.model;
  if (!model) return void answer({ success: false, error: "no model" });
  const transcript = buildTitleTranscript(session.messages);
  if (!transcript) return void answer({ success: false, error: "nothing to name" });
  const levels = session.getAvailableThinkingLevels();
  const cheapest = levels.find((level) => level !== "off");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  timer.unref();
  try {
    const reply = await session.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: `${transcript}\n\n${TITLE_PROMPT}` }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: TITLE_MAX_TOKENS,
        signal: controller.signal,
        ...(levels.includes("off") || !cheapest ? {} : { reasoning: cheapest }),
      },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      return void answer({
        success: false,
        error: controller.signal.aborted ? "title generation timed out" : "the model call failed",
      });
    }
    const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    const title = parseTitle(text);
    if (!title) return void answer({ success: false, error: "the model gave no title" });
    session.setSessionName(title);
    answer({ success: true, data: { title } });
  } catch (error) {
    answer({
      success: false,
      error: controller.signal.aborted ? "title generation timed out" : messageOf(error),
    });
  } finally {
    clearTimeout(timer);
  }
}
