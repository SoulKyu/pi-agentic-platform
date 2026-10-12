import type { PartialBlock, PartialMessage, PiEvent } from "@pap/contracts";

const STARTS: Readonly<Record<string, PartialBlock["type"]>> = {
  text_start: "text",
  thinking_start: "thinking",
  toolcall_start: "toolCall",
};
const DELTAS: Readonly<Record<string, PartialBlock["type"]>> = {
  text_delta: "text",
  thinking_delta: "thinking",
  toolcall_delta: "toolCall",
};
const MAX_BLOCKS = 64;
/** A reply longer than this is not kept: the snapshot would leave it out anyway (PARTIAL_BYTES), and `message_end` carries it. */
export const MAX_PARTIAL_CHARS = 256 * 1024;

export interface PartialReply {
  apply(event: PiEvent): void;
  current(): PartialMessage | null;
  reset(): void;
}

/**
 * The assistant reply being written, rebuilt from the events the stream has sent, never from deltas still pending:
 * a snapshot taken now plus the frames after it then give the reply exactly once (Review Focus 1).
 */
export function createPartialReply(): PartialReply {
  let blocks: PartialBlock[] | null = null;
  let chars = 0;
  const blockAt = (index: number, type: PartialBlock["type"]): PartialBlock | null => {
    if (!blocks || !Number.isInteger(index) || index < 0 || index >= MAX_BLOCKS) return null;
    const existing = blocks[index];
    if (existing) return existing;
    for (let i = blocks.length; i < index; i++) blocks[i] = { type: "text", text: "" };
    const created: PartialBlock = { type, text: "" };
    blocks[index] = created;
    return created;
  };
  return {
    apply(event) {
      const role = (event.message as { role?: unknown } | undefined)?.role;
      if (event.type === "message_start" && role === "assistant") {
        blocks = [];
        chars = 0;
      } else if (event.type === "message_end" && role === "assistant") blocks = null;
      else if (event.type === "agent_end" || event.type === "agent_settled") blocks = null;
      else if (event.type === "message_update") {
        const update = (event.assistantMessageEvent ?? {}) as {
          type?: string;
          contentIndex?: number;
          delta?: unknown;
          id?: unknown;
          toolName?: unknown;
        };
        const index = update.contentIndex ?? -1;
        const started = update.type ? STARTS[update.type] : undefined;
        if (started) {
          const block = blockAt(index, started);
          if (block && typeof update.id === "string") block.id = update.id.slice(0, 256);
          if (block && typeof update.toolName === "string") block.name = update.toolName.slice(0, 256);
          return;
        }
        const grows = update.type ? DELTAS[update.type] : undefined;
        if (grows && typeof update.delta === "string") {
          chars += update.delta.length;
          // Past the cap the reply is dropped until the next one starts, never kept growing.
          if (chars > MAX_PARTIAL_CHARS) blocks = null;
          const block = blockAt(index, grows);
          if (block) block.text += update.delta;
        }
      }
    },
    current: () => (blocks ? { blocks: blocks.map((block) => ({ ...block })) } : null),
    reset() {
      blocks = null;
    },
  };
}
