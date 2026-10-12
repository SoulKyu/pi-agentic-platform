const USER_CHARS = 800;
const REPLY_CHARS = 300;
const LAST_REPLY_CHARS = 600;
const TRANSCRIPT_CHARS = 6000;
/** A session often states its goal early and drifts into chores: the opening turns keep this share of the budget. */
const HEAD_CHARS = Math.round(TRANSCRIPT_CHARS * 0.4);
const MAX_TITLE_CHARS = 80;
const ELISION = "[…]";

export const TITLE_SYSTEM_PROMPT = "You name chat sessions from a transcript. Reply with the title only.";
export const TITLE_PROMPT = [
  "Write a short title for the session above.",
  "- Use the language the user writes in.",
  "- Name the user's goal or the outcome, not the act of chatting.",
  "- 4 to 12 words (8 to 24 characters for Chinese, Japanese or Korean).",
  "- Do not call any tool.",
  "- Reply with the title alone: no quotes, label, markdown or explanation.",
].join("\n");

type Block = { type?: unknown; text?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((block) =>
      block?.type === "text" && typeof block.text === "string"
        ? block.text
        : block?.type === "image"
          ? "[image]"
          : "",
    )
    .filter(Boolean)
    .join(" ");
}

const cut = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}${ELISION}` : flat;
};

/** The lines the model reads: every user turn and the replies' text, tool calls and results left out. */
export function buildTitleTranscript(messages: readonly unknown[]): string {
  const turns = messages.flatMap((raw) => {
    const message = (raw ?? {}) as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textOf(message.content);
    return text.trim() ? [{ role: message.role, text }] : [];
  });
  if (!turns.some((turn) => turn.role === "user")) return "";
  const lastReply = turns.findLastIndex((turn) => turn.role === "assistant");
  const lines = turns.map((turn, index) =>
    turn.role === "user"
      ? `User: ${cut(turn.text, USER_CHARS)}`
      : `Assistant: ${cut(turn.text, index === lastReply ? LAST_REPLY_CHARS : REPLY_CHARS)}`,
  );
  const whole = lines.join("\n");
  if (whole.length <= TRANSCRIPT_CHARS) return whole;
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > HEAD_CHARS) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail: string[] = [];
  for (const line of lines.slice(head.length).toReversed()) {
    if (used + line.length + 1 > TRANSCRIPT_CHARS - ELISION.length - 1) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  return [...head, ELISION, ...tail].join("\n");
}

/** The first line of the model's answer, without quotes, markdown or a "Title:" label, at most 80 characters. */
export function parseTitle(raw: string): string | null {
  const line = raw
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;
  const bare = line
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, " ")
    .trim()
    .replace(/^title\s*:\s*/i, "")
    .replace(/^[*_#>`\s]+|[*_`\s]+$/g, "")
    .replace(/^["'«“‘]+|["'»”’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!bare) return null;
  const points = Array.from(bare);
  if (points.length <= MAX_TITLE_CHARS) return bare;
  const room = points.slice(0, MAX_TITLE_CHARS - 1).join("");
  const space = room.lastIndexOf(" ");
  return `${(space > 20 ? room.slice(0, space) : room).trimEnd()}…`;
}
