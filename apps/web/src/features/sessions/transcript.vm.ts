import type { SessionView } from "../../stores/session-reducer.ts";

export interface TranscriptItem {
  readonly key: string;
  readonly author: "agent" | "you" | "tool";
  readonly text: string;
}

export function transcriptItems(view: SessionView): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of view.messages) {
    const author = message.role === "user" ? "you" : message.role === "assistant" ? "agent" : "tool";
    const text = [message.text, ...message.toolCalls.map((call) => `${call.name}: ${call.summary}`)]
      .filter(Boolean)
      .join("\n");
    if (text) items.push({ key: message.key, author, text });
  }
  if (view.partialText) items.push({ key: "partial", author: "agent", text: view.partialText });
  return items;
}
