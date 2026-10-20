import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { NO_TAINT, type PolicyAuditEntry } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createRedactor } from "./redact.ts";
import { onToolResult, type ResultDeps } from "./results.ts";
import { createExternalRoots, createTaint } from "./taint.ts";
import { classifyTool } from "./tool-kind.ts";

const redactor = createRedactor({ entries: [] });

function setup(took: number | null = 42) {
  const audits: PolicyAuditEntry[] = [];
  const deps: ResultDeps = {
    secrets: { current: () => redactor, refresh: () => {} },
    audit: (entry) => void audits.push(entry),
    classify: (name) => classifyTool(name, { path: `builtin:${name}` }),
    taint: createTaint(NO_TAINT, () => {}),
    roots: createExternalRoots(),
    took: () => took ?? undefined,
  };
  return { audits, deps };
}
const event = (toolName: string, extra: Record<string, unknown> = {}): ToolResultEvent =>
  ({
    type: "tool_result",
    toolCallId: "c1",
    toolName,
    input: {},
    isError: false,
    content: [{ type: "text", text: "plain" }],
    details: undefined,
    ...extra,
  }) as unknown as ToolResultEvent;

describe("a result row says what ran and how long it took (decision 117, A4)", () => {
  it("records the exit code and the duration of a shell call that exits 3, though nothing was redacted", () => {
    const { audits, deps } = setup(42);
    onToolResult(event("bash", { structuredContent: { output: "x", exit_code: 3 }, isError: true }), deps);
    expect(audits).toEqual([
      expect.objectContaining({ kind: "result", tool: "bash", exitCode: 3, durationMs: 42 }),
    ]);
  });

  it("records exit code 0 for a shell call that worked", () => {
    const { audits, deps } = setup(5);
    onToolResult(event("bash", { structuredContent: { exit_code: 0 } }), deps);
    expect(audits[0]).toMatchObject({ exitCode: 0, durationMs: 5 });
  });

  it("leaves the exit code out when the shell result has none or a non-integer one", () => {
    const { audits, deps } = setup(5);
    onToolResult(event("bash"), deps);
    onToolResult(event("bash", { structuredContent: { exit_code: "3" } }), deps);
    expect(audits).toHaveLength(2);
    for (const entry of audits) expect(entry).not.toHaveProperty("exitCode");
  });

  it("writes no row for a clean result of a tool that is not a shell, and no exit code on a row it does write", () => {
    const { audits, deps } = setup();
    onToolResult(event("read", { structuredContent: { exit_code: 9 } }), deps);
    expect(audits).toEqual([]);
    onToolResult(
      event("read", { content: [{ type: "text", text: "see ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] }),
      {
        ...deps,
        secrets: {
          current: () =>
            createRedactor({ entries: [{ name: "GH", value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] }),
          refresh: () => {},
        },
      },
    );
    expect(audits[0]).toMatchObject({ tool: "read", durationMs: 42 });
    expect(audits[0]).not.toHaveProperty("exitCode");
  });

  it("omits the duration when the call was not timed, and never stores output", () => {
    const { audits, deps } = setup(null);
    onToolResult(event("bash", { structuredContent: { output: "SECRET-OUTPUT", exit_code: 1 } }), deps);
    expect(audits[0]).not.toHaveProperty("durationMs");
    expect(JSON.stringify(audits)).not.toContain("SECRET-OUTPUT");
  });
});
