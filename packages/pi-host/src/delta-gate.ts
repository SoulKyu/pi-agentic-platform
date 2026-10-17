import type { Redactor } from "./policy/redact.ts";
import { createStreamRedactor } from "./redact-stream.ts";
import type { WireEvent } from "./wire-events.ts";

const KINDS = ["text", "thinking", "toolcall"] as const;
type Kind = (typeof KINDS)[number];
interface Update {
  readonly type: string;
  readonly contentIndex?: number;
  readonly delta?: string;
}
const updateOf = (record: WireEvent): Update | null =>
  record.type === "message_update" && typeof record["assistantMessageEvent"] === "object"
    ? (record["assistantMessageEvent"] as Update)
    : null;
const kindOf = (type: string, suffix: "delta" | "end"): Kind | null =>
  KINDS.find((kind) => type === `${kind}_${suffix}`) ?? null;
/** Ends the whole message: what is still held goes out first. */
const ENDS_MESSAGE = new Set(["message_end", "agent_end", "turn_end"]);
const ENDS_STREAM = new Set(["done", "error"]);

/**
 * W5-R60: the pieces of a message the model is typing (`text_delta`, `thinking_delta`, `toolcall_delta`) leave the worker
 * redacted. The worker sees each piece alone, and a provider cuts a value into pieces of a few characters, so one stream
 * redactor per content block holds back only the longest tail that is a prefix of a known value form (its core is the
 * command output's), so plain text streams at once, and releases the rest. The held tail goes out, redacted, before the end of its block, of the message, an error or an abort.
 */
export function createDeltaGate(current: () => Redactor) {
  const blocks = new Map<
    string,
    { kind: Kind; index: number; stream: ReturnType<typeof createStreamRedactor> }
  >();
  let usage: unknown;
  const piece = (kind: Kind, index: number, text: string): WireEvent => ({
    type: "message_update",
    usage,
    assistantMessageEvent: { type: `${kind}_delta`, contentIndex: index, delta: text },
  });
  const flush = (only?: string): WireEvent[] => {
    const out: WireEvent[] = [];
    for (const [key, block] of [...blocks]) {
      if (only !== undefined && key !== only) continue;
      blocks.delete(key);
      const rest = block.stream.flushText();
      if (rest !== "") out.push(piece(block.kind, block.index, rest));
    }
    return out;
  };
  return {
    apply(record: WireEvent): WireEvent[] {
      const update = updateOf(record);
      if (update === null) return ENDS_MESSAGE.has(record.type) ? [...flush(), record] : [record];
      if ("usage" in record) usage = record["usage"];
      const index = update.contentIndex ?? 0;
      const delta = kindOf(update.type, "delta");
      if (delta !== null && typeof update.delta === "string") {
        const key = `${delta}:${index}`;
        const block = blocks.get(key) ?? { kind: delta, index, stream: createStreamRedactor(current) };
        blocks.set(key, block);
        const released = block.stream.pushText(update.delta);
        if (released === "") return [];
        return [{ ...record, assistantMessageEvent: { ...update, delta: released } }];
      }
      const ending = kindOf(update.type, "end");
      if (ending !== null) return [...flush(`${ending}:${index}`), record];
      return ENDS_STREAM.has(update.type) ? [...flush(), record] : [record];
    },
  };
}
