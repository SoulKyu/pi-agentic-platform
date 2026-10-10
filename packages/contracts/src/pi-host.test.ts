import { describe, expect, it } from "vitest";
import { AuditEntry, DaemonToWorker, InitRecord, TOOL_CATEGORIES, parseWorkerRecord } from "./index.ts";

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

describe("worker record routing", () => {
  const PAP_RECORD_TYPES = [
    "ready",
    "response",
    "extension_ui_request",
    "extension_ui_closed",
    "audit",
    "health",
    "extension_error",
  ];

  it.each(PAP_RECORD_TYPES)("never forwards a malformed %s as a Pi event", (type) => {
    expect(parseWorkerRecord({ type })).toBeNull();
  });
});

describe("InitRecord", () => {
  const init = { type: "init", cwd: "/work", agentDir: "/agent", papHome: "/pap", policy: {} };

  it("requires the pap data directory", () => {
    expect(InitRecord.safeParse(init).success).toBe(true);
    expect(InitRecord.safeParse({ ...init, papHome: undefined }).success).toBe(false);
    expect(DaemonToWorker.safeParse({ ...init, papHome: undefined }).success).toBe(false);
  });

  it.each(["", "pap", "./pap", "~/.pap", "../pap", "/pap\0x"])(
    "rejects %j as a pap data directory",
    (papHome) => {
      expect(InitRecord.safeParse({ ...init, papHome }).success).toBe(false);
    },
  );

  it("holds every path the policy judges to the same rule", () => {
    expect(InitRecord.safeParse({ ...init, cwd: "work" }).success).toBe(false);
    expect(InitRecord.safeParse({ ...init, agentDir: "agent" }).success).toBe(false);
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
