import { describe, expect, it } from "vitest";
import { EDGE_WITHHELD_TEXT, maskCuts, maskEdges } from "./edges.ts";
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
    const big = { ...record, partialResult: { content: [{ type: "text", text: `${"a".repeat(65_535)}c` }] } };
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
    const part = { type: "text", text: `${"a".repeat(1999)}c` };
    const record = {
      type: "tool_execution_update",
      toolCallId: "c",
      partialResult: { content: [part, part, part, part, part, part, part, part, part, part] },
    };
    const done = redactRecord(record, hostile) as typeof record;
    // 2 000 characters cost about 2 000 comparisons for each of the 4 091 candidate lengths up to the spent budget:
    // the first parts are checked and withheld one by one, none keeps its text.
    expect(done.partialResult.content.map((p) => p.text)).toEqual(Array(10).fill(EDGE_WITHHELD_TEXT));
  });

  it("masks the JSON-escaped forms too: a secret with a quote and a backslash (a documented 7-15 of 21 leak before)", () => {
    const json = { name: "J", value: 'ab"cd\\ef-12345' };
    expect(maskEdges('\\"cd\\\\ef-12345 rest', [json], fresh())).toEqual({
      text: "[SECRET:J] rest",
      count: 1,
    });
    expect(maskEdges('x ab\\"cd\\\\ef-1', [json], fresh())).toEqual({ text: "x [SECRET:J]", count: 1 });
  });

  it("masks the whole text when a head and a tail would overlap", () => {
    expect(maskEdges("ABCDwxyz", [{ name: "P", value: "ABCDwxyzABCDwxyz" }], fresh())).toEqual({
      text: "[SECRET:P]",
      count: 1,
    });
    const s = { name: "S", value: "ABCDEFGHwxyz" };
    expect(maskEdges("wxyzABCDEFGH", [s], fresh())).toEqual({ text: "[SECRET:S][SECRET:S]", count: 2 });
  });

  it("masks a run that U+FFFD hides: a window cut inside a multi-byte character", () => {
    expect(maskEdges("\uFFFDret_0123456789 x", [GITHUB], fresh())).toEqual({
      text: "[SECRET:GITHUB_TOKEN] x",
      count: 1,
    });
    expect(maskEdges("x ghp_testse\uFFFD\uFFFD", [GITHUB], fresh())).toEqual({
      text: "x [SECRET:GITHUB_TOKEN]",
      count: 1,
    });
    expect(maskEdges("\uFFFD789 x", [GITHUB], fresh())).toEqual({ text: "\uFFFD789 x", count: 0 });
  });

  it("masks only the side it is asked to", () => {
    const text = "ret_0123456789 mid ghp_testse";
    expect(maskEdges(text, [GITHUB], fresh(), { tail: true })).toEqual({
      text: "ret_0123456789 mid [SECRET:GITHUB_TOKEN]",
      count: 1,
    });
    expect(maskEdges(text, [GITHUB], fresh(), { head: true }).text).toBe(
      "[SECRET:GITHUB_TOKEN] mid ghp_testse",
    );
  });
});

describe("maskCuts: output Pi cut before it was redacted", () => {
  it("masks the head only when Pi says the output was cut", () => {
    expect(maskCuts("ret_0123456789 and more", [GITHUB], fresh(), true)).toEqual({
      text: "[SECRET:GITHUB_TOKEN] and more",
      count: 1,
    });
    expect(maskCuts("ret_0123456789 and more", [GITHUB], fresh(), false)).toEqual({
      text: "ret_0123456789 and more",
      count: 0,
    });
  });

  it("treats the end of a line that ends in the truncation notice as a cut tail", () => {
    expect(
      maskCuts(
        "a.ts:3: x ghp_testse... [truncated]\nb.ts:1: ghp_ok\nc: ghp_tes... [truncated]",
        [GITHUB],
        fresh(),
        false,
      ),
    ).toEqual({
      text: "a.ts:3: x [SECRET:GITHUB_TOKEN]... [truncated]\nb.ts:1: ghp_ok\nc: [SECRET:GITHUB_TOKEN]... [truncated]",
      count: 2,
    });
  });
});
