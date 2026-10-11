import { describe, expect, it } from "vitest";
import {
  AuditEntry,
  DaemonToWorker,
  InitRecord,
  PolicyRules,
  TOOL_CATEGORIES,
  parseWorkerRecord,
} from "./index.ts";

describe("worker records", () => {
  it("parses pap records strictly", () => {
    const ready = { type: "ready", sessionFile: "/s.jsonl", sessionId: "abc", piVersion: "1.1.0" };
    expect(parseWorkerRecord(ready)).toEqual({ ...ready, leafId: null, sessionName: null });
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
    "custom_render",
    "custom_close",
    "approval_request",
  ];

  it.each(PAP_RECORD_TYPES)("never forwards a malformed %s as a Pi event", (type) => {
    expect(parseWorkerRecord({ type })).toBeNull();
  });
});

describe("InitRecord", () => {
  const init = { type: "init", cwd: "/work", agentDir: "/agent", papHome: "/pap", umask: 0o022, policy: {} };

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

  it("requires the umask the worker runs its tools under (R114)", () => {
    for (const umask of [0, 0o022, 0o077, 0o777]) {
      expect(InitRecord.safeParse({ ...init, umask }).success, String(umask)).toBe(true);
    }
    for (const umask of [undefined, -1, 0o1000, 18.5, "022", null, Number.NaN]) {
      expect(InitRecord.safeParse({ ...init, umask }).success, String(umask)).toBe(false);
    }
    expect(DaemonToWorker.safeParse({ ...init, umask: undefined }).success).toBe(false);
  });

  it.each(["sessionFile", "testProviderScript"])("holds %s to the same absolute-path rule", (field) => {
    expect(InitRecord.safeParse({ ...init, [field]: "/abs/file" }).success).toBe(true);
    expect(InitRecord.safeParse({ ...init, [field]: "relative/file" }).success).toBe(false);
    expect(InitRecord.safeParse({ ...init, [field]: "" }).success).toBe(false);
  });

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

const KEY = "a".repeat(64);

describe("protocol v2 records", () => {
  it("parses the new worker records as pap records, never as Pi events", () => {
    const render = { type: "custom_render", id: "p1", lines: ["> a"] };
    const approval = {
      type: "approval_request",
      id: "a1",
      category: "exec",
      title: "Run a command?",
      message: "1 line\nbash: ls",
      answers: ["deny", "once"],
      tool: "bash",
      key: KEY,
    };
    expect(parseWorkerRecord(render)).toEqual(render);
    expect(parseWorkerRecord({ type: "custom_close", id: "p1" })).toEqual({ type: "custom_close", id: "p1" });
    expect(parseWorkerRecord(approval)).toEqual(approval);
    expect(parseWorkerRecord({ ...approval, key: "not-hex" })).toBeNull();
    expect(parseWorkerRecord({ ...approval, answers: ["once", "once"] })).toBeNull();
    expect(parseWorkerRecord({ type: "custom_render", id: "p1" })).toBeNull();
  });

  it("parses a leaf record as a pap record, and refuses one without a boolean resync", () => {
    const leaf = { type: "leaf", leafId: "e9", resync: false };
    expect(parseWorkerRecord(leaf)).toEqual(leaf);
    expect(parseWorkerRecord({ type: "leaf", leafId: null, resync: true })).toEqual({
      type: "leaf",
      leafId: null,
      resync: true,
    });
    expect(parseWorkerRecord({ type: "leaf", leafId: "e9" })).toBeNull();
    expect(parseWorkerRecord({ type: "leaf", leafId: 4, resync: false })).toBeNull();
  });

  it("defaults the leaf and name of ready to null", () => {
    const ready = { type: "ready", sessionFile: "/s.jsonl", sessionId: "abc", piVersion: "1.1.0" };
    expect(parseWorkerRecord(ready)).toEqual({ ...ready, leafId: null, sessionName: null });
    expect(parseWorkerRecord({ ...ready, leafId: "e9", sessionName: "Fix login" })).toEqual({
      ...ready,
      leafId: "e9",
      sessionName: "Fix login",
    });
  });

  it.each([
    { type: "clear_queue", id: "r1" },
    { type: "compact", id: "r1", customInstructions: "keep the API notes" },
    { type: "navigate_tree", id: "r1", targetId: "e4" },
    { type: "set_session_name", id: "r1", name: "Fix login" },
    { type: "export_html", id: "r1", outputPath: "/pap/exports/x.html" },
    { type: "auto_name", id: "r1" },
    { type: "custom_input", id: "p1", data: "\r" },
    { type: "custom_cancel", id: "p1" },
    { type: "approval_response", id: "a1", answer: "session" },
    { type: "approval_response", id: "a1", answer: "deny", cancelled: true },
  ])("accepts the daemon record $type", (record) => {
    expect(DaemonToWorker.safeParse(record).success).toBe(true);
  });

  it("refuses an export path that is not absolute and an answer outside the four", () => {
    expect(DaemonToWorker.safeParse({ type: "export_html", id: "r1", outputPath: "x.html" }).success).toBe(
      false,
    );
    expect(DaemonToWorker.safeParse({ type: "approval_response", id: "a1", answer: "yes" }).success).toBe(
      false,
    );
  });

  it("defaults always rules to none and bounds them", () => {
    const base = { profile: "interactive", approvalMode: "auto-accept-edits" };
    expect(PolicyRules.parse(base).alwaysAllow).toEqual([]);
    expect(PolicyRules.safeParse({ ...base, alwaysAllow: [{ tool: "bash", key: "xyz" }] }).success).toBe(
      false,
    );
    const many = Array.from({ length: 1001 }, () => ({ tool: "bash", key: KEY }));
    expect(PolicyRules.safeParse({ ...base, alwaysAllow: many }).success).toBe(false);
  });
});
