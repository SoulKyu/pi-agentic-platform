import type { PartialBlock, PartialMessage } from "@pap/contracts";

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
/** Mirrors the daemon's bound: a reply past it is not kept until the next assistant message; `message_end` has it whole. */
const MAX_PARTIAL_CHARS = 256 * 1024;

interface UpdateFields {
  type?: string;
  contentIndex?: number;
  delta?: unknown;
  id?: unknown;
  toolName?: unknown;
}

const withBlock = (
  blocks: readonly PartialBlock[],
  index: number,
  type: PartialBlock["type"],
  change: (block: PartialBlock) => PartialBlock,
): PartialBlock[] | null => {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_BLOCKS) return null;
  const next = blocks.slice();
  for (let i = next.length; i < index; i++) next[i] = { type: "text", text: "" };
  next[index] = change(next[index] ?? { type, text: "" });
  return next;
};

/** The reply being written after one more Pi event: a new value, the input untouched. */
export function applyPartial(
  partial: PartialMessage | null,
  event: { type: string } & Record<string, unknown>,
): PartialMessage | null {
  const role = (event.message as { role?: unknown } | undefined)?.role;
  if (event.type === "message_start" && role === "assistant") return { blocks: [] };
  if (event.type === "message_end" && role === "assistant") return null;
  if (event.type === "agent_end" || event.type === "agent_settled") return null;
  if (event.type !== "message_update" || !partial) return partial;
  const update = (event.assistantMessageEvent ?? {}) as UpdateFields;
  const index = update.contentIndex ?? -1;
  const started = update.type ? STARTS[update.type] : undefined;
  if (started) {
    const blocks = withBlock(partial.blocks, index, started, (block) => ({
      ...block,
      ...(typeof update.id === "string" ? { id: update.id.slice(0, 256) } : {}),
      ...(typeof update.toolName === "string" ? { name: update.toolName.slice(0, 256) } : {}),
    }));
    return blocks ? { blocks } : partial;
  }
  const grows = update.type ? DELTAS[update.type] : undefined;
  if (grows && typeof update.delta === "string") {
    const delta = update.delta;
    const chars = partial.blocks.reduce((sum, block) => sum + block.text.length, 0) + delta.length;
    if (chars > MAX_PARTIAL_CHARS) return null;
    const blocks = withBlock(partial.blocks, index, grows, (block) => ({
      ...block,
      text: block.text + delta,
    }));
    return blocks ? { blocks } : partial;
  }
  return partial;
}
