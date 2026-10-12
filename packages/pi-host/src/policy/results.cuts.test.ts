import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { PolicyAuditEntry } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createRedactor } from "./redact.ts";
import { onToolResult } from "./results.ts";
import { classifyTool } from "./tool-kind.ts";

const SECRET = "ghp_testsecret_0123456789";
const redactor = createRedactor({ entries: [{ name: "GH", value: SECRET }] });
const audits: PolicyAuditEntry[] = [];
const deps = {
  secrets: { current: () => redactor, refresh: () => {} },
  audit: (entry: PolicyAuditEntry) => void audits.push(entry),
  classify: (name: string) => classifyTool(name, { path: `builtin:${name}` }),
};
const event = (toolName: string, text: string, details: unknown): ToolResultEvent =>
  ({
    type: "tool_result",
    toolCallId: "c",
    toolName,
    input: {},
    isError: false,
    content: [{ type: "text", text }],
    details,
  }) as unknown as ToolResultEvent;

describe("what a tool result hands Pi when Pi cut it before the redaction", () => {
  it("masks the head of a bash output Pi says it truncated, a single 51 KB line cut mid-token", () => {
    const tail = SECRET.slice(10);
    const result = onToolResult(
      event("bash", `${tail} and the rest`, { truncation: { truncated: true, lastLinePartial: true } }),
      deps,
    );
    expect(result?.content).toEqual([{ type: "text", text: "[SECRET:GH] and the rest" }]);
    expect(audits.at(-1)).toMatchObject({ kind: "result", redactions: 1 });
  });

  it("leaves the head of an output Pi did not cut", () => {
    const text = `${SECRET.slice(10)} and the rest`;
    expect(onToolResult(event("bash", text, { truncation: { truncated: false } }), deps)).toBeUndefined();
    expect(onToolResult(event("bash", text, undefined), deps)).toBeUndefined();
  });

  it("masks the end of a grep line Pi clipped at 500 characters", () => {
    const result = onToolResult(
      event(
        "grep",
        `a.ts:3: x ${SECRET.slice(0, 7)}... [truncated]\nb.ts:1: ${SECRET.slice(0, 7)} fine`,
        undefined,
      ),
      deps,
    );
    expect(result?.content).toEqual([
      { type: "text", text: `a.ts:3: x [SECRET:GH]... [truncated]\nb.ts:1: ${SECRET.slice(0, 7)} fine` },
    ]);
  });

  it("withholds the result when the edge check runs out of budget", () => {
    const hostile = createRedactor({ entries: [{ name: "X", value: `${"a".repeat(4095)}b` }] });
    const result = onToolResult(event("bash", "a".repeat(65_536), { truncation: { truncated: true } }), {
      ...deps,
      secrets: { current: () => hostile, refresh: () => {} },
    });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text" }] });
    expect(JSON.stringify(result)).not.toContain("aaaa");
  });
});
