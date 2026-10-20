import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { NO_TAINT, type PolicyAuditEntry } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditSinkOf } from "./audit-sink.ts";
import { createRedactor, type Redactor } from "./redact.ts";
import {
  onToolResult,
  redactAuditReasons,
  redactingAuditSink,
  type ResultDeps,
  WITHHELD_TEXT,
} from "./results.ts";
import { collectSecrets, type SecretReader } from "./secrets.ts";
import { createExternalRoots, createTaint } from "./taint.ts";
import { classifyTool } from "./tool-kind.ts";

const set = { entries: [{ name: "GH", value: "ghp_abcdefgh" }] };
const sourceOf = (value: { entries: ReadonlyArray<{ name: string; value: string }> }): SecretReader => {
  const redactor = createRedactor(value);
  return { current: () => redactor, refresh: () => {} };
};

function deps(options: {
  audits?: PolicyAuditEntry[];
  redactor?: Redactor;
  secrets?: SecretReader;
  audit?: (entry: PolicyAuditEntry) => void;
}): ResultDeps {
  const { audits, redactor, secrets, audit } = options;
  return {
    secrets: secrets ?? (redactor ? sourceWith(redactor) : sourceOf(set)),
    audit: audit ?? ((entry) => void audits?.push(entry)),
    classify: (name) => classifyTool(name, { path: `builtin:${name}` }),
    taint: createTaint(NO_TAINT, () => {}),
    roots: createExternalRoots(),
  };
}
function resultEvent(text: string, extra: Record<string, unknown> = {}): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "c",
    toolName: "bash",
    input: {},
    isError: false,
    content: [{ type: "text", text }],
    details: undefined,
    ...extra,
  } as unknown as ToolResultEvent;
}
const sourceWith = (redactor: Redactor): SecretReader => ({ current: () => redactor, refresh: () => {} });

// The withheld path writes a line to stderr: the unit run prints nothing.
let quiet: { mockRestore(): void } | undefined;
beforeEach(() => {
  quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => quiet?.mockRestore());

describe("tool_result hook", () => {
  it("redacts text, structured content and details, and audits the count", () => {
    const audits: PolicyAuditEntry[] = [];
    const out = onToolResult(
      resultEvent("tok=ghp_abcdefgh", {
        structuredContent: { out: "ghp_abcdefgh" },
        details: { fullOutputPath: "/tmp/x", raw: "ghp_abcdefgh" },
      }),
      deps({ audits }),
    );
    expect(out).toEqual({
      content: [{ type: "text", text: "tok=[SECRET:GH]" }],
      structuredContent: { out: "[SECRET:GH]" },
      details: { fullOutputPath: "/tmp/x", raw: "[SECRET:GH]" },
    });
    expect(audits).toEqual([
      {
        kind: "result",
        toolCallId: "c",
        tool: "bash",
        redactions: 3,
        external: false,
        stages: [
          { stage: "06", outcome: "acted", reason: "3 secrets redacted" },
          { stage: "07", outcome: "pass" },
        ],
      },
    ]);
  });

  it("says '1 secret' for one, keeps images and non-secret parts, and the parent id", () => {
    const audits: PolicyAuditEntry[] = [];
    const image = { type: "image", data: "ghp_abcdefgh", mimeType: "image/png" };
    const out = onToolResult(resultEvent("ghp_abcdefgh", { parentToolCallId: "p" }), deps({ audits }));
    expect(out).toEqual({ content: [{ type: "text", text: "[SECRET:GH]" }] });
    expect(audits[0]).toMatchObject({ parentToolCallId: "p", stages: [{ reason: "1 secret redacted" }, {}] });
    const mixed = onToolResult(
      resultEvent("x", { content: [image, { type: "text", text: "a ghp_abcdefgh" }] }),
      deps({}),
    );
    expect(mixed?.content).toEqual([image, { type: "text", text: "a [SECRET:GH]" }]);
  });

  it("changes nothing and writes no stage-acted entry when no stage acted: only the shell's clean row (M5R10, MQ9, A4)", () => {
    const audits: PolicyAuditEntry[] = [];
    expect(onToolResult(resultEvent("plain"), deps({ audits }))).toBeUndefined();
    // The row is the shell's own (decision 117, A4): no stage acted, nothing was redacted.
    expect(audits).toEqual([
      expect.objectContaining({
        kind: "result",
        redactions: 0,
        external: false,
        stages: [
          { stage: "06", outcome: "pass" },
          { stage: "07", outcome: "pass" },
        ],
      }),
    ]);
  });

  it("leaves a placeholder value alone: the word postgres is not a secret (MQ5)", () => {
    const audits: PolicyAuditEntry[] = [];
    const secrets = sourceOf(collectSecrets({ env: { DB_PASSWORD: "postgres" }, authJson: null }));
    expect(
      onToolResult(resultEvent("connect to postgres as postgres"), deps({ audits, secrets })),
    ).toBeUndefined();
    expect(audits).toEqual([
      expect.objectContaining({
        kind: "result",
        redactions: 0,
        external: false,
        stages: [
          { stage: "06", outcome: "pass" },
          { stage: "07", outcome: "pass" },
        ],
      }),
    ]);
  });

  it("withholds the result when redaction throws, and when its audit record cannot leave (M5R37, M5R114)", () => {
    const audits: PolicyAuditEntry[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const broken = {
        ...createRedactor(set),
        deep: () => {
          throw new Error("boom ghp_abcdefgh");
        },
      };
      const withheld = {
        content: [{ type: "text", text: WITHHELD_TEXT }],
        isError: true,
        details: {},
      };
      expect(
        onToolResult(resultEvent("x", { structuredContent: { a: 1 } }), deps({ audits, redactor: broken })),
      ).toEqual(withheld);
      expect(audits[0]).toMatchObject({
        kind: "result",
        redactions: 0,
        stages: [
          { stage: "06", outcome: "block", reason: "redaction failed: result withheld" },
          expect.anything(),
        ],
      });
      expect(
        onToolResult(resultEvent("tok=ghp_abcdefgh"), deps({ audit: auditSinkOf(() => false) })),
      ).toEqual(withheld);
      const written = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(written).not.toContain("ghp_abcdefgh");
      expect(written).not.toContain("boom");
    } finally {
      stderr.mockRestore();
    }
  });

  it("withholds structured content 33 levels deep and a cyclic details object", () => {
    const levels = Array.from({ length: 33 }).reduce<unknown>((inner) => ({ inner }), "x");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const extra of [{ structuredContent: levels }, { details: cycle }]) {
      const out = onToolResult(resultEvent("fine", extra), deps({ audits: [] }));
      expect(out).toMatchObject({ isError: true, content: [{ text: WITHHELD_TEXT }] });
    }
  });

  it("refreshes the secret source once per result", () => {
    const refreshed: number[] = [];
    const secrets = { current: () => createRedactor(set), refresh: () => void refreshed.push(1) };
    onToolResult(resultEvent("plain"), deps({ secrets }));
    onToolResult(resultEvent("plain"), deps({ secrets }));
    expect(refreshed).toHaveLength(2);
  });

  it("a refresh that throws withholds the result", () => {
    const secrets = {
      current: () => createRedactor(set),
      refresh: () => {
        throw new Error("stat");
      },
    };
    expect(onToolResult(resultEvent("plain"), deps({ secrets, audits: [] }))).toMatchObject({
      isError: true,
    });
  });
});

describe("audit reasons", () => {
  const redactor = createRedactor({ entries: [{ name: "H", value: "Internal-Host.Example.COM" }] });
  const entry = {
    kind: "call",
    toolCallId: "c",
    tool: "bash",
    category: "exec",
    decision: "block",
    reason: "host internal-host.example.com is not allowed",
    stages: [{ stage: "02", outcome: "block", reason: "INTERNAL-HOST.EXAMPLE.COM refused" }],
    args: "curl x",
  } satisfies PolicyAuditEntry;

  it("redacts the reason and every stage reason without regard to case", () => {
    expect(redactAuditReasons(entry, redactor)).toEqual({
      ...entry,
      reason: "host [SECRET:H] is not allowed",
      stages: [{ stage: "02", outcome: "block", reason: "[SECRET:H] refused" }],
    });
  });

  it("returns the very same entry when no reason holds a secret", () => {
    const clean = {
      ...entry,
      reason: "fine",
      stages: [{ stage: "02", outcome: "pass" }],
    } as PolicyAuditEntry;
    expect(redactAuditReasons(clean, redactor)).toBe(clean);
  });

  it("handles session entries, which have no reason of their own", () => {
    const session = {
      kind: "session",
      stages: [],
      tools: [],
      toolsTruncated: false,
      mode: "auto-accept-edits",
    } as PolicyAuditEntry;
    expect(redactAuditReasons(session, redactor)).toBe(session);
  });

  it("uses the redactor given: sourceWith keeps the helper honest", () => {
    expect(sourceWith(redactor).current()).toBe(redactor);
  });
});

describe("the audit sink wrapper", () => {
  const source = (): SecretReader => ({
    current: () => createRedactor({ entries: [{ name: "H", value: "Internal-Host.Example.COM" }] }),
    refresh: () => {},
  });
  it("sends the entry with its reasons redacted, whatever the case", () => {
    const sent: PolicyAuditEntry[] = [];
    redactingAuditSink(
      (entry) => void sent.push(entry),
      source(),
    )({
      kind: "call",
      toolCallId: "c",
      tool: "bash",
      category: "exec",
      decision: "block",
      reason: "host internal-host.example.com is not allowed",
      stages: [{ stage: "02", outcome: "block", reason: "internal-host.example.com" }],
      args: "x",
    });
    expect(sent).toMatchObject([
      { reason: "host [SECRET:H] is not allowed", stages: [{ reason: "[SECRET:H]" }] },
    ]);
  });
  it("lets the sink's refusal through, so the pipeline blocks", () => {
    const sink = redactingAuditSink(
      auditSinkOf(() => false),
      source(),
    );
    expect(() =>
      sink({ kind: "session", stages: [], tools: [], toolsTruncated: false, mode: "auto-accept-edits" }),
    ).toThrow();
  });
});
