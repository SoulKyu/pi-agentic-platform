const MAX_SUMMARY = 200;

export interface EditPair {
  readonly oldText: string;
  readonly newText: string;
}
export interface EditArgs {
  readonly path: string;
  readonly edits: readonly EditPair[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asPair = (value: unknown): EditPair | null =>
  isRecord(value) && typeof value.oldText === "string" && typeof value.newText === "string"
    ? { oldText: value.oldText, newText: value.newText }
    : null;

/** An edit call's arguments: `{path, edits: [{oldText, newText}]}` or `{path, oldText, newText}`; null for anything else. */
export function editArgsOf(args: unknown): EditArgs | null {
  if (!isRecord(args) || typeof args.path !== "string") return null;
  if (Array.isArray(args.edits)) {
    const pairs = args.edits.map(asPair);
    return pairs.every((pair) => pair !== null) ? { path: args.path, edits: pairs } : null;
  }
  const single = asPair(args);
  return single ? { path: args.path, edits: [single] } : null;
}

/** The arguments as `sessions.toolOutput` returns them (JSON text); null when they do not parse as an edit. */
export function parseEdits(argsText: string | null): EditArgs | null {
  if (argsText === null) return null;
  try {
    return editArgsOf(JSON.parse(argsText));
  } catch {
    return null;
  }
}

const linesOf = (text: string): string[] => (text === "" ? [] : text.split("\n"));

/** Lines added and removed once the leading and trailing lines both sides share are trimmed. */
export function editCounts(edits: readonly EditPair[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const { oldText, newText } of edits) {
    const before = linesOf(oldText);
    const after = linesOf(newText);
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
    let tail = 0;
    while (
      tail < before.length - head &&
      tail < after.length - head &&
      before[before.length - 1 - tail] === after[after.length - 1 - tail]
    )
      tail += 1;
    removed += before.length - head - tail;
    added += after.length - head - tail;
  }
  return { added, removed };
}

const jsonSummary = (args: unknown): { summary: string; argsTruncated: boolean } => {
  const command = (args as { command?: unknown } | null)?.command;
  const text = typeof command === "string" ? command : (JSON.stringify(args ?? {}) ?? "");
  return text.length > MAX_SUMMARY
    ? { summary: `${text.slice(0, MAX_SUMMARY)}…`, argsTruncated: true }
    : { summary: text, argsTruncated: false };
};

const cutPath = (path: string): { text: string; cut: boolean } =>
  path.length > MAX_SUMMARY
    ? { text: `${path.slice(0, MAX_SUMMARY)}…`, cut: true }
    : { text: path, cut: false };

/** What a tool card's header says about a call: an edit its file and counts, read and write their path, any other tool its JSON cut at 200. */
export function summarize(name: string, args: unknown): { summary: string; argsTruncated: boolean } {
  if (name === "edit") {
    const edit = editArgsOf(args);
    if (edit) {
      const { added, removed } = editCounts(edit.edits);
      const path = cutPath(edit.path);
      return { summary: `${path.text} · +${added} −${removed}`, argsTruncated: path.cut };
    }
  }
  if ((name === "read" || name === "write") && isRecord(args) && typeof args.path === "string") {
    const path = cutPath(args.path);
    return { summary: path.text, argsTruncated: path.cut };
  }
  return jsonSummary(args);
}
