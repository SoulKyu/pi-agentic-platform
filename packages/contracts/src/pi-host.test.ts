import { describe, expect, it } from "vitest";
import { AuditEntry, DaemonToWorker, TOOL_CATEGORIES, parseWorkerRecord } from "./index.ts";

describe("worker records", () => {
  it("parses pap records strictly", () => {
    const ready = { type: "ready", sessionFile: "/s.jsonl", sessionId: "abc", piVersion: "1.1.0" };
    expect(parseWorkerRecord(ready)).toEqual(ready);
    expect(parseWorkerRecord({ type: "ready", sessionId: "abc" })).toBeNull();
  });

  it("keeps extra fields of extension_ui_request", () => {
    const record = {
      type: "extension_ui_request",
      id: "u1",
      method: "confirm",
      title: "Run?",
      message: "bash: ls",
    };
    expect(parseWorkerRecord(record)).toEqual(record);
  });

  it("wraps any other typed object as a Pi event", () => {
    expect(parseWorkerRecord({ type: "agent_settled", aborted: false })).toEqual({
      type: "pi_event",
      event: { type: "agent_settled", aborted: false },
    });
  });

  it("drops values without a string type", () => {
    expect(parseWorkerRecord(null)).toBeNull();
    expect(parseWorkerRecord({ type: 3 })).toBeNull();
    expect(parseWorkerRecord("agent_start")).toBeNull();
  });

  it("rejects unknown daemon-to-worker records", () => {
    expect(DaemonToWorker.safeParse({ type: "rm_rf" }).success).toBe(false);
    expect(DaemonToWorker.safeParse({ type: "get_state", id: "r1" }).success).toBe(true);
  });
});

describe("tool categories", () => {
  it("includes unknown for tools with no known category", () => {
    expect(TOOL_CATEGORIES).toEqual(["read", "edit", "exec", "network", "external-write", "unknown"]);
  });

  it("accepts every category in an audit entry and rejects others", () => {
    for (const category of TOOL_CATEGORIES) {
      expect(AuditEntry.safeParse({ toolCallId: "t1", tool: "x", category, decision: "block" }).success).toBe(
        true,
      );
    }
    expect(
      AuditEntry.safeParse({ toolCallId: "t1", tool: "x", category: "other", decision: "block" }).success,
    ).toBe(false);
  });
});
