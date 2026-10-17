import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { EgressHost, EgressReport, PolicyAuditEntry } from "@pap/contracts";
import { NO_TAINT } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { egressVerdict } from "./egress-taint.ts";
import { createRedactor } from "./redact.ts";
import { onToolResult, type ResultDeps } from "./results.ts";
import { createExternalRoots, createTaint } from "./taint.ts";
import { classifyTool, SANDBOX_SOURCE } from "./tool-kind.ts";

const TRUSTED = ["docs.trusted.test"];
const redactor = createRedactor({ entries: [] });
const entry = (over: Partial<EgressHost> = {}): EgressHost => ({
  host: "docs.trusted.test",
  port: 443,
  kind: "connect",
  verdict: "allowed",
  ...over,
});
const reportOf = (hosts: EgressHost[]): EgressReport => ({
  type: "egress_report",
  id: "c1",
  hosts,
  truncated: false,
  up: 0,
  down: 0,
});

function bed(kept: Record<string, EgressReport | null>, network = true, wired = true) {
  const reports = new Map(Object.entries(kept));
  const audits: PolicyAuditEntry[] = [];
  const raised: boolean[] = [];
  const taint = createTaint(NO_TAINT, () => void raised.push(true));
  const taken: string[] = [];
  const deps: ResultDeps = {
    secrets: { current: () => redactor, refresh: () => {} },
    audit: (record) => void audits.push(record),
    classify: (name) => classifyTool(name, { path: SANDBOX_SOURCE, sandboxNetwork: network }),
    taint,
    roots: createExternalRoots(),
    ...(wired
      ? {
          egress: {
            check(toolCallId: string) {
              taken.push(toolCallId);
              const report = reports.get(toolCallId);
              reports.delete(toolCallId);
              return egressVerdict(report, TRUSTED);
            },
          },
        }
      : {}),
  };
  return { deps, audits, taint, taken };
}
const result = (text = "page text", toolCallId = "c1"): ToolResultEvent =>
  ({
    type: "tool_result",
    toolCallId,
    toolName: "bash",
    input: {},
    isError: false,
    content: [{ type: "text", text }],
    details: undefined,
  }) as unknown as ToolResultEvent;

describe("a networked sandboxed shell's result (M11R233)", () => {
  it("is plain when the proxy saw only trusted sources, writes a stage 07 pass row and does not taint", () => {
    const b = bed({ c1: reportOf([entry()]) });
    expect(onToolResult(result(), b.deps)).toBeUndefined();
    expect(b.taint.current()).toBe(false);
    expect(b.audits).toEqual([
      {
        kind: "result",
        toolCallId: "c1",
        tool: "bash",
        redactions: 0,
        external: false,
        stages: [
          { stage: "06", outcome: "pass" },
          { stage: "07", outcome: "pass", reason: "egress: trusted sources only" },
        ],
      },
    ]);
  });

  it("is plain when the command used no network, with its own reason", () => {
    const b = bed({ c1: reportOf([]) });
    expect(onToolResult(result(), b.deps)).toBeUndefined();
    expect(b.audits[0]?.stages[1]).toEqual({
      stage: "07",
      outcome: "pass",
      reason: "egress: no network used",
    });
    expect(b.taint.current()).toBe(false);
  });

  it("is fenced and taints when the proxy saw an untrusted host", () => {
    const b = bed({ c1: reportOf([entry({ host: "other.test" })]) });
    const out = onToolResult(result(), b.deps);
    expect(JSON.stringify(out)).toContain("page text");
    expect(JSON.stringify(out)).not.toBe(JSON.stringify(result()));
    expect(out?.content?.[0]).toMatchObject({ type: "text" });
    expect((out?.content?.[0] as { text: string }).text).not.toBe("page text");
    expect(b.taint.current()).toBe(true);
    expect(b.audits[0]).toMatchObject({ external: true, stages: [{}, { stage: "07", outcome: "acted" }] });
    // The row never claims a clean reason for a result that tainted.
    expect(b.audits[0]?.stages[1]).toEqual({
      stage: "07",
      outcome: "acted",
      reason: "egress: untrusted host reached",
    });
  });

  it("names a cut report as the reason of the fenced row", () => {
    const b = bed({ c1: { ...reportOf([]), truncated: true } });
    onToolResult(result(), b.deps);
    expect(b.taint.current()).toBe(true);
    expect(b.audits[0]?.stages[1]).toEqual({ stage: "07", outcome: "acted", reason: "egress: report cut" });
  });

  it("is fenced and taints when there is no report for the call", () => {
    const b = bed({});
    const out = onToolResult(result(), b.deps);
    expect((out?.content?.[0] as { text: string }).text).not.toBe("page text");
    expect(b.taint.current()).toBe(true);
    expect(b.audits[0]?.stages[1]).toEqual({ stage: "07", outcome: "acted", reason: "egress: no report" });
  });

  it("takes the report once, by the tool call id of this result", () => {
    const b = bed({ c1: reportOf([entry()]), c2: reportOf([entry({ host: "other.test" })]) });
    expect(onToolResult(result("a", "c2"), b.deps)).not.toBeUndefined();
    expect(onToolResult(result("b", "c1"), b.deps)).toBeUndefined();
    expect(onToolResult(result("c", "c1"), b.deps)).not.toBeUndefined();
    expect(b.taken).toEqual(["c2", "c1", "c1"]);
  });

  it("leaves a network-off shell unchanged: never external, no report asked, no row", () => {
    const b = bed({}, false);
    expect(onToolResult(result(), b.deps)).toBeUndefined();
    expect(b.taken).toEqual([]);
    expect(b.audits).toEqual([]);
    expect(b.taint.current()).toBe(false);
  });

  it("still redacts a clean result and writes the row with the count", () => {
    const b = bed({ c1: reportOf([]) });
    const secrets = createRedactor({ entries: [{ name: "GH", value: "ghp_abcdefgh" }] });
    const out = onToolResult(result("tok=ghp_abcdefgh"), {
      ...b.deps,
      secrets: { current: () => secrets, refresh: () => {} },
    });
    expect((out?.content?.[0] as { text: string }).text).toBe("tok=[SECRET:GH]");
    expect(b.audits[0]).toMatchObject({
      redactions: 1,
      external: false,
      stages: [
        { stage: "06", outcome: "acted" },
        { stage: "07", outcome: "pass", reason: "egress: no network used" },
      ],
    });
  });

  it("treats a result with no egress wiring as external (an unknown result is never trusted)", () => {
    const b = bed({ c1: reportOf([]) }, true, false);
    const out = onToolResult(result(), b.deps);
    expect((out?.content?.[0] as { text: string }).text).not.toBe("page text");
    expect(b.taint.current()).toBe(true);
  });
});
