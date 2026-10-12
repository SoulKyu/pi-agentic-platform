import { describe, expect, it } from "vitest";
import { groupItems } from "./transcript-groups.ts";
import type { MessageItem, ToolItem, TranscriptItem } from "./transcript.vm.ts";

const message = (key: string, author: MessageItem["author"]): MessageItem => ({
  kind: "message",
  key,
  author,
  text: key,
  thinking: "",
  entryId: null,
});
const tool = (key: string): ToolItem => ({
  kind: "tool",
  key,
  toolCallId: key,
  name: "read",
  summary: "",
  status: "done",
  preview: "",
  truncatedChars: null,
  argsTruncated: false,
  resultEntryId: null,
  omittedBytes: null,
});
const shape = (items: TranscriptItem[]) =>
  groupItems(items).map((group) =>
    group.kind === "run" ? [group.author, ...group.items.map((item) => item.key)] : ["lone", group.item.key],
  );

describe("groupItems", () => {
  it("puts repeated authors under one header, tool calls with the agent", () => {
    expect(
      shape([
        message("u1", "you"),
        message("u2", "you"),
        message("a1", "agent"),
        tool("t1"),
        message("a2", "agent"),
        message("u3", "you"),
      ]),
    ).toEqual([
      ["you", "u1", "u2"],
      ["agent", "a1", "t1", "a2"],
      ["you", "u3"],
    ]);
  });

  it("lets a summary, a failure and a tool-authored message stand alone and break the run", () => {
    const summary: TranscriptItem = {
      kind: "summary",
      key: "s",
      variant: "compaction",
      text: "",
      tokensBefore: null,
      entryId: null,
    };
    const failure: TranscriptItem = { kind: "failure", key: "f", text: "x" };
    expect(
      shape([message("a1", "agent"), summary, message("a2", "agent"), message("b", "tool"), failure]),
    ).toEqual([
      ["agent", "a1"],
      ["lone", "s"],
      ["agent", "a2"],
      ["lone", "b"],
      ["lone", "f"],
    ]);
  });

  it("keeps a run's key when it grows", () => {
    const first = groupItems([message("a1", "agent")])[0]?.key;
    const grown = groupItems([message("a1", "agent"), tool("t1")])[0]?.key;
    expect(grown).toBe(first);
  });
});
