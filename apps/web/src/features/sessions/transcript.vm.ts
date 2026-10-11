import { t } from "../../i18n/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";

export interface TranscriptItem {
  readonly key: string;
  readonly author: "agent" | "you" | "tool";
  readonly text: string;
  /** The provider failed: the text is why, to be shown as an error. */
  readonly failure?: true;
}

const BYTES_PER_KB = 1024;

export function transcriptItems(view: SessionView): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of view.messages) {
    const author = message.role === "user" ? "you" : message.role === "assistant" ? "agent" : "tool";
    const text =
      message.omittedBytes === null
        ? [message.text, ...message.toolCalls.map((call) => `${call.name}: ${call.summary}`)]
            .filter(Boolean)
            .join("\n")
        : t("session.omitted", { size: Math.max(1, Math.round(message.omittedBytes / BYTES_PER_KB)) });
    if (text) items.push({ key: message.key, author, text });
    if (message.error !== null) {
      items.push({
        key: `${message.key}:failure`,
        author: "agent",
        text: message.error || t("error.internal"),
        failure: true,
      });
    }
  }
  // Thinking and tool-call blocks of the partial reply are not shown here.
  const partialText = (view.partial?.blocks ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (partialText) items.push({ key: "partial", author: "agent", text: partialText });
  return items;
}
