import type { PiEvent } from "@pap/contracts";
import { sizeOf } from "../../kernel/json-bytes.ts";
import { cutUnits } from "../../kernel/text.ts";

export const TOOL_PREVIEW_CHARS = 8000;
export const UPDATE_PREVIEW_CHARS = 2000;
export const ARG_PREVIEW_CHARS = 8000;
const DETAILS_BYTES = 8 * 1024;
const MAX_DEPTH = 8;
export const MAX_ITEMS = 1000;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function omittedImage(block: Json): Json {
  const data = typeof block.data === "string" ? block.data : "";
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return {
    type: "image",
    mimeType: block.mimeType,
    omitted: true,
    bytes: Math.max(0, Math.floor((data.length * 3) / 4) - padding),
  };
}

/** Text blocks cut to `budget` characters in all; images replaced by their size. */
function clipContent(content: unknown, budget: number): { content: unknown; chars: number; cut: boolean } {
  if (typeof content === "string") {
    return { content: cutUnits(content, budget), chars: content.length, cut: content.length > budget };
  }
  if (!Array.isArray(content)) return { content, chars: 0, cut: false };
  let left = budget;
  let chars = 0;
  let cut = false;
  const kept: unknown[] = [];
  for (const block of content) {
    if (isObject(block) && block.type === "image") {
      kept.push(omittedImage(block));
      cut = true;
    } else if (isObject(block) && block.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
      if (left === 0) cut = true;
      else if (block.text.length > left) {
        kept.push({ ...block, text: cutUnits(block.text, left) });
        left = 0;
        cut = true;
      } else {
        kept.push(block);
        left -= block.text.length;
      }
    } else kept.push(block);
  }
  return { content: kept, chars, cut };
}

/** Strings over the preview size cut, at any depth up to 8; deeper values are left out. */
export function clipArguments(value: unknown, depth = 0): { value: unknown; cut: boolean } {
  if (typeof value === "string") {
    return value.length > ARG_PREVIEW_CHARS
      ? { value: cutUnits(value, ARG_PREVIEW_CHARS), cut: true }
      : { value, cut: false };
  }
  if (typeof value !== "object" || value === null) return { value, cut: false };
  if (depth >= MAX_DEPTH) return { value: null, cut: true };
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  // Wide values are cut too: walking a million-item array per event would stall the daemon.
  let cut = entries.length > MAX_ITEMS;
  const walk = (item: unknown) => {
    const result = clipArguments(item, depth + 1);
    cut ||= result.cut;
    return result.value;
  };
  const kept = entries.slice(0, MAX_ITEMS);
  const next = Array.isArray(value)
    ? kept.map(([, item]) => walk(item))
    : Object.fromEntries(kept.map(([key, item]) => [key, walk(item)]));
  return { value: cut ? next : value, cut };
}

export function clipMessage(message: unknown): unknown {
  if (!isObject(message)) return message;
  if (message.role === "toolResult") {
    const { content, chars, cut } = clipContent(message.content, TOOL_PREVIEW_CHARS);
    const bigDetails = message.details !== undefined && sizeOf(message.details) > DETAILS_BYTES;
    if (!cut && !bigDetails) return message;
    return { ...message, content, ...(bigDetails ? { details: undefined } : {}), papTruncated: { chars } };
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    let any = false;
    const content = message.content.map((block: unknown) => {
      if (!isObject(block) || block.type !== "toolCall") return block;
      const { value, cut } = clipArguments(block.arguments);
      if (!cut) return block;
      any = true;
      return { ...block, arguments: value, papTruncated: true };
    });
    return any ? { ...message, content } : message;
  }
  return message;
}

function tail(partialResult: unknown): unknown {
  const content = isObject(partialResult) ? partialResult.content : partialResult;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => (isObject(block) && typeof block.text === "string" ? block.text : ""))
            .join("")
        : "";
  return {
    content: [{ type: "text", text: text.slice(-UPDATE_PREVIEW_CHARS) }],
    ...(text.length > UPDATE_PREVIEW_CHARS ? { papTruncated: { chars: text.length } } : {}),
  };
}

/**
 * A `message_update` as it goes on the wire: the end of a text or thinking block drops its `content` (the client has
 * every delta), a finished tool call keeps its arguments clipped like a message's (M2-RT-30, R111).
 */
function clipUpdate(event: PiEvent): PiEvent {
  const update = event.assistantMessageEvent;
  if (!isObject(update)) return event;
  if (update.type === "text_end" || update.type === "thinking_end") {
    const rest = { ...update };
    delete rest.content;
    return { ...event, assistantMessageEvent: rest };
  }
  if (update.type === "toolcall_end" && isObject(update.toolCall)) {
    const { value, cut } = clipArguments(update.toolCall.arguments);
    if (!cut) return event;
    return {
      ...event,
      assistantMessageEvent: {
        ...update,
        toolCall: { ...update.toolCall, arguments: value, papTruncated: true },
      },
    };
  }
  return event;
}

/** Pi's failure text is for the log, not for subscribers (R66): the event keeps a `failed` flag in its place. */
function withoutErrorText(event: PiEvent, field: string, flag: boolean): PiEvent {
  if (!(field in event)) return event;
  const rest = Object.fromEntries(Object.entries(event).filter(([key]) => key !== field)) as PiEvent;
  return flag ? { ...rest, failed: true } : rest;
}

/** What a client is sent for a Pi event. Null: not sent at all (the progress of a call made inside another tool). */
export function clipPiEvent(event: PiEvent): PiEvent | null {
  switch (event.type) {
    case "message_update":
      return clipUpdate(event);
    case "message_start":
    case "message_end":
    case "turn_end":
      return event.message === undefined ? event : { ...event, message: clipMessage(event.message) };
    case "tool_execution_start": {
      const { value, cut } = clipArguments(event.args);
      return cut ? { ...event, args: value, papTruncated: true } : event;
    }
    case "tool_execution_update":
      if (typeof event.parentToolCallId === "string") return null;
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: tail(event.partialResult),
      };
    case "tool_execution_end": {
      const rest = { ...event };
      delete rest.result;
      return rest;
    }
    case "compaction_end":
      return withoutErrorText(event, "errorMessage", true);
    case "auto_retry_end":
      return withoutErrorText(event, "finalError", true);
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return withoutErrorText(event, "errorMessage", false);
    default:
      return event;
  }
}
