export interface LineComment {
  readonly line: number;
  readonly side: "before" | "after";
  readonly text: string;
}

export function addComment(list: readonly LineComment[], comment: LineComment): LineComment[] {
  return [...list.filter((c) => !(c.line === comment.line && c.side === comment.side)), comment].sort((a, b) => a.line - b.line);
}
