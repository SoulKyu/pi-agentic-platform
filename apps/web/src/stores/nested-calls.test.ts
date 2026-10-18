import { describe, expect, it } from "vitest";
import { nestedCallsOf } from "./nested-calls.ts";
import { toMessageView } from "./row-view.ts";

const must = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("missing");
  return value;
};

// Shape from Pi's docs/message-types.md (NestedToolCalls): bounded metadata, never results.
const recorded = {
  calls: [
    { id: "cm1/1", name: "read", arguments: { path: "README.md" }, status: "ok", durationMs: 4 },
    {
      id: "cm1/2",
      name: "bash",
      arguments: { command: "false" },
      status: "error",
      durationMs: 1200,
      error: "exit 1",
    },
    { id: "cm1/3", name: "grep", argumentsBytes: 99999, status: "unfinished" },
  ],
  complete: true,
};

describe("nestedCallsOf", () => {
  it("reads name, one-line arguments, status and duration; unfinished means cancelled", () => {
    expect(nestedCallsOf(recorded)).toEqual([
      { name: "read", args: '{"path":"README.md"}', status: "ok", durationMs: 4, error: null },
      { name: "bash", args: '{"command":"false"}', status: "error", durationMs: 1200, error: "exit 1" },
      { name: "grep", args: "", status: "cancelled", durationMs: null, error: null },
    ]);
  });

  it("is undefined when the message has none, and skips entries it cannot read", () => {
    expect(nestedCallsOf(undefined)).toBeUndefined();
    expect(nestedCallsOf({ calls: "x" })).toBeUndefined();
    expect(nestedCallsOf({ calls: [null, 3, { name: 4 }, { name: "ok", status: "ok" }] })).toEqual([
      { name: "ok", args: "", status: "ok", durationMs: null, error: null },
    ]);
  });

  it("never shows a call it cannot read the status of as ok", () => {
    expect(nestedCallsOf({ calls: [{ name: "a" }, { name: "b", status: "weird" }] })).toEqual([
      { name: "a", args: "", status: "cancelled", durationMs: null, error: null },
      { name: "b", args: "", status: "cancelled", durationMs: null, error: null },
    ]);
  });

  it("cuts long arguments and errors, and keeps at most 256 calls", () => {
    const [call] = must(
      nestedCallsOf({ calls: [{ name: "x", arguments: { a: "y".repeat(500) }, error: "e".repeat(900) }] }),
    );
    expect(must(call).args.length).toBeLessThanOrEqual(201);
    expect(must(call).args.endsWith("…")).toBe(true);
    expect(must(must(call).error).length).toBeLessThanOrEqual(301);
    const many = { calls: Array.from({ length: 400 }, () => ({ name: "r" })) };
    expect(nestedCallsOf(many)).toHaveLength(256);
  });
});

describe("toMessageView for codemode", () => {
  it("carries the script of a codemode call and the nested calls of its result", () => {
    const call = must(
      toMessageView({
        role: "assistant",
        content: [{ type: "toolCall", id: "cm1", name: "codemode", arguments: { code: "text(1)" } }],
      }),
    );
    expect(must(call.toolCalls[0]).code).toBe("text(1)");
    const result = must(
      toMessageView({
        role: "toolResult",
        toolCallId: "cm1",
        content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n1" }],
        nestedCalls: recorded,
      }),
    );
    expect(result.nestedCalls).toHaveLength(3);
  });

  it("gives no script to another tool or to non-string code", () => {
    const view = must(
      toMessageView({
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "bash", arguments: { code: "x" } },
          { type: "toolCall", id: "b", name: "codemode", arguments: { code: 3 } },
        ],
      }),
    );
    expect(view.toolCalls.map((c) => c.code)).toEqual([undefined, undefined]);
  });
});
