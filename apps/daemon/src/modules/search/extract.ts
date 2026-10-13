import { MAX_ID_CHARS } from "../../kernel/text.ts";
import { indexText, type IndexRow } from "./index-store.ts";

export interface Extracted {
  readonly rows: IndexRow[];
  /** The last `session_info` name read (raw); `undefined` when none was. */
  readonly name: string | null | undefined;
  readonly firstUser: string | null;
  /** A user or assistant message was read: activity for the 3-day rule (M4R41). */
  readonly active: boolean;
}

const MAX_MILLIS = 8.64e15;
const timeOf = (entry: { timestamp?: unknown }, message: { timestamp?: unknown }): number => {
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  const raw = Number.isFinite(parsed)
    ? parsed
    : typeof message.timestamp === "number"
      ? message.timestamp
      : 0;
  return Math.min(MAX_MILLIS, Math.max(0, Math.trunc(Number.isFinite(raw) ? raw : 0)));
};

function textOf(role: "user" | "assistant", content: unknown): string {
  if (typeof content === "string") return role === "user" ? content : "";
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
    )
    .map((block) => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** What a chunk of Pi entries gives the index and the session (M4R59). */
export function extract(records: ReadonlyArray<Record<string, unknown>>): Extracted {
  const rows: IndexRow[] = [];
  let name: string | null | undefined;
  let firstUser: string | null = null;
  let active = false;
  for (const record of records) {
    if (record.type === "session_info") {
      name = typeof record.name === "string" ? record.name : null;
      continue;
    }
    if (record.type !== "message") continue;
    const message = (record.message ?? {}) as { role?: unknown; content?: unknown; timestamp?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    active = true;
    const raw = textOf(message.role, message.content);
    if (message.role === "user" && firstUser === null && raw.trim() !== "") firstUser = raw;
    const id = record.id;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) continue;
    const text = indexText(raw);
    if (text.trim() === "") continue;
    rows.push({ entryId: id, role: message.role, at: timeOf(record, message), text });
  }
  return { rows, name, firstUser, active };
}
