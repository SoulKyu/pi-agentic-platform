import { describe, expect, it } from "vitest";
import { EDGE_WITHHELD_TEXT, maskEdges } from "./edges.ts";
import { createRedactor } from "./redact.ts";
import { redactRecord } from "../redacting-ipc.ts";

const GITHUB = { name: "GITHUB_TOKEN", value: "ghp_testsecret_0123456789" };
const fresh = () => ({ left: 1_000_000 });

describe("maskEdges (M5R120)", () => {
  it("masks a head that is the end of a secret and a tail that is the start of one", () => {
    expect(maskEdges("ret_0123456789\nnext line", [GITHUB], fresh())).toEqual({
      text: "[SECRET:GITHUB_TOKEN]\nnext line",
      count: 1,
    });
    expect(maskEdges("output line\nghp_testse", [GITHUB], fresh())).toEqual({
      text: "output line\n[SECRET:GITHUB_TOKEN]",
      count: 1,
    });
  });

  it("masks 4 characters, leaves 3, leaves plain text and leaves a whole secret to the exact redactor", () => {
    expect(maskEdges("6789 x", [GITHUB], fresh()).text).toBe("[SECRET:GITHUB_TOKEN] x");
    expect(maskEdges("789 x", [GITHUB], fresh())).toEqual({ text: "789 x", count: 0 });
    expect(maskEdges("plain", [GITHUB], fresh())).toEqual({ text: "plain", count: 0 });
    expect(maskEdges(GITHUB.value, [GITHUB], fresh())).toEqual({ text: GITHUB.value, count: 0 });
  });

  it("never writes two overlapping markers when one run is both the tail and the head of a secret", () => {
    expect(maskEdges("abcd", [{ name: "X", value: "abcdXabcd" }], fresh())).toEqual({
      text: "[SECRET:X]",
      count: 1,
    });
  });

  it("throws RangeError once the budget is spent, and the record's text part is withheld", () => {
    expect(() => maskEdges("ret_0123456789\nnext line", [GITHUB], { left: 10 })).toThrow(RangeError);
    const text = "x".repeat(10);
    const record = {
      type: "tool_execution_update",
      toolCallId: "c",
      partialResult: { content: [{ type: "text", text }], details: {} },
    };
    const hostile = createRedactor({ entries: [{ name: "X", value: `${"a".repeat(4095)}b` }] });
    const big = { ...record, partialResult: { content: [{ type: "text", text: "a".repeat(65_536) }] } };
    const done = redactRecord(big, hostile) as typeof big;
    expect(done.partialResult.content[0]?.text).toBe(EDGE_WITHHELD_TEXT);
  });

  it("hostile secret of identical letters against a text of the same letter ends at once, never a hang", () => {
    const same = createRedactor({ entries: [{ name: "X", value: "a".repeat(4096) }] });
    const record = {
      type: "tool_execution_end",
      toolCallId: "c",
      result: { content: [{ type: "text", text: "a".repeat(65_536) }] },
    };
    const done = redactRecord(record, same) as typeof record;
    expect(done.result.content[0]?.text).toBe("[SECRET:X]".repeat(16));
  });

  it("a budget is charged per record: a second text part cannot reset it", () => {
    const hostile = createRedactor({ entries: [{ name: "X", value: `${"a".repeat(4095)}b` }] });
    const part = { type: "text", text: "a".repeat(2000) };
    const record = {
      type: "tool_execution_update",
      toolCallId: "c",
      partialResult: { content: [part, part, part, part, part, part, part, part, part, part] },
    };
    const done = redactRecord(record, hostile) as typeof record;
    expect(done.partialResult.content.map((p) => p.text)).toContain(EDGE_WITHHELD_TEXT);
  });
});
