import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { PolicyAuditEntry } from "@pap/contracts";
import { NO_TAINT } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { addStreamCount } from "../redact-stream.ts";
import { createRedactor } from "./redact.ts";
import { onToolResult, type ResultDeps } from "./results.ts";
import { createExternalRoots, createTaint } from "./taint.ts";
import { classifyTool, SANDBOX_SOURCE } from "./tool-kind.ts";

// The sandboxed shell hands Pi redacted output, so stage 06 finds nothing left to replace; the audit row still says how many
// values the stream redaction replaced (ADR 0022, M5R10).
function run(text: string, toolCallId: string, redactor = createRedactor({ entries: [] })) {
  const audits: PolicyAuditEntry[] = [];
  const deps: ResultDeps = {
    secrets: { current: () => redactor, refresh: () => {} },
    audit: (record) => void audits.push(record),
    classify: (name) => classifyTool(name, { path: SANDBOX_SOURCE, sandboxNetwork: false }),
    taint: createTaint(NO_TAINT, () => {}),
    roots: createExternalRoots(),
  };
  const event = {
    type: "tool_result",
    toolCallId,
    toolName: "bash",
    input: {},
    isError: false,
    content: [{ type: "text", text }],
    details: undefined,
  } as unknown as ToolResultEvent;
  return { returned: onToolResult(event, deps), audits };
}

describe("stage 06 and the stream redaction of a sandboxed command", () => {
  it("writes one result row that counts what the stream replaced, and leaves the text as it is", () => {
    addStreamCount("call-1", 1);
    const { returned, audits } = run("v=[SECRET:V]\n", "call-1");
    expect(returned).toBeUndefined();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      kind: "result",
      toolCallId: "call-1",
      redactions: 1,
      stages: expect.arrayContaining([{ stage: "06", outcome: "acted", reason: "1 secret redacted" }]),
    });
  });

  it("adds the stream's count to its own", () => {
    addStreamCount("call-2", 2);
    const known = createRedactor({ entries: [{ name: "K", value: "pap-leftover-value-1" }] });
    const { audits } = run("two [SECRET:A] [SECRET:B] pap-leftover-value-1\n", "call-2", known);
    expect(audits[0]).toMatchObject({ redactions: 3 });
  });

  it("writes no row for a command whose stream replaced nothing", () => {
    expect(run("plain\n", "call-3").audits).toEqual([]);
  });
});
