import { basename } from "node:path";
import { writeFileSync } from "node:fs";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const header = (piId: string) => ({
  type: "session",
  version: 3,
  id: piId,
  timestamp: "2026-10-10T00:00:00.000Z",
  cwd: "/w",
});

// Pi puts its system prompt in the file as the first message (S1); the daemon never shows it (R107).
const systemEntry = {
  type: "message",
  id: "s0",
  parentId: null,
  timestamp: "2026-10-10T00:00:00.500Z",
  message: {
    role: "system",
    content: "",
    sections: { preamble: "You are an expert coding assistant" },
    timestamp: 0,
  },
};

const userEntry = (id: string, parentId: string, text: string, at = "2026-10-10T00:00:01.000Z") => ({
  type: "message",
  id,
  parentId,
  timestamp: at,
  message: { role: "user", content: text, timestamp: 1 },
});

const assistantEntry = (id: string, parentId: string, content: unknown[], stopReason = "stop") => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-10T00:00:02.000Z",
  message: {
    role: "assistant",
    content,
    api: "x",
    provider: "x",
    model: "x",
    usage,
    stopReason,
    timestamp: 2,
  },
});

const textOf = (text: string) => [{ type: "text", text }];
const jsonl = (rows: readonly unknown[]): string => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

/** A Pi session file (format 3) holding these exchanges, as `[user text, assistant text]`. */
export function sessionFileText(piId: string, exchanges: ReadonlyArray<readonly [string, string]>): string {
  const rows: unknown[] = [header(piId), systemEntry];
  let parentId = "s0";
  exchanges.forEach(([user, assistant], index) => {
    rows.push(
      userEntry(`u${index}`, parentId, user),
      assistantEntry(`a${index}`, `u${index}`, textOf(assistant)),
    );
    parentId = `a${index}`;
  });
  return jsonl(rows);
}

/**
 * A file with one `read` call of `{ path: "big.txt" }` whose result is `output`: entries s0, u0, a0 (the call), t0 (its
 * result), a1 (the closing reply).
 */
export function writeToolSession(file: string, toolCallId: string, output: string): void {
  writeFileSync(
    file,
    jsonl([
      header(basename(file, ".jsonl")),
      systemEntry,
      userEntry("u0", "s0", "read it"),
      assistantEntry(
        "a0",
        "u0",
        [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "big.txt" } }],
        "toolUse",
      ),
      {
        type: "message",
        id: "t0",
        parentId: "a0",
        timestamp: "2026-10-10T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId,
          toolName: "read",
          content: textOf(output),
          isError: false,
          timestamp: 3,
        },
      },
      assistantEntry("a1", "t0", textOf("done")),
    ]),
  );
}

/**
 * A file whose entry a0 has two user children: u1 (the older one, abandoned) and u2 (on the path to the last entry,
 * a2).
 */
export function writeForkedSession(file: string): void {
  writeFileSync(
    file,
    jsonl([
      header(basename(file, ".jsonl")),
      systemEntry,
      assistantEntry("a0", "s0", textOf("hello")),
      userEntry("u1", "a0", "first try", "2026-10-10T00:00:04.000Z"),
      userEntry("u2", "a0", "second try", "2026-10-10T00:00:05.000Z"),
      assistantEntry("a2", "u2", textOf("answer")),
    ]),
  );
}

/**
 * A chain of `points` fork points on the active branch, each with `choices` user children (the last one continues the
 * chain), whose ids are `idLength` characters long and whose texts are control characters: the worst case for the size
 * of `sessions.branches`.
 */
export function writeWideForkSession(
  file: string,
  { points, choices, idLength }: { points: number; choices: number; idLength: number },
): void {
  const id = (name: string) => name.padEnd(idLength, "-");
  const rows: unknown[] = [header(basename(file, ".jsonl")), systemEntry];
  let parent = "s0";
  for (let point = 0; point < points; point++) {
    for (let choice = 0; choice < choices - 1; choice++) {
      rows.push(userEntry(id(`k${point}.${choice}`), parent, "\u0001".repeat(200)));
    }
    const next = id(`p${point}`);
    rows.push(userEntry(next, parent, "\u0001".repeat(200)));
    parent = next;
  }
  writeFileSync(file, jsonl(rows));
}
