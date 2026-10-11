import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, methods } from "./index.ts";

describe("method catalogue", () => {
  it("keys every method by its own name and declares a known permission", () => {
    for (const [key, def] of Object.entries(methods)) {
      expect(def.name).toBe(key);
      expect(ALL_PERMISSIONS).toContain(def.permission);
    }
  });

  it("marks exactly the mutations as non-idempotent (they require a commandId)", () => {
    const mutations = Object.values(methods)
      .filter((def) => !def.idempotent)
      .map((def) => def.name)
      .sort();
    expect(mutations).toEqual([
      "sessions.abort",
      "sessions.clearQueue",
      "sessions.create",
      "sessions.prompt",
      "sessions.respondDialog",
    ]);
  });

  it("declares the session reads as idempotent sessions:read queries", () => {
    for (const name of ["sessions.history", "sessions.toolOutput", "sessions.branches"] as const) {
      expect(methods[name]).toMatchObject({ permission: "sessions:read", idempotent: true });
    }
  });

  it("declares clearQueue as a sessions:operate mutation that can time out", () => {
    expect(methods["sessions.clearQueue"]).toMatchObject({
      permission: "sessions:operate",
      idempotent: false,
      errors: ["not_found", "worker_failed", "timeout"],
    });
    expect(methods["sessions.prompt"].errors).toContain("queue_full");
  });

  it("bounds what a history request can ask for", () => {
    const { params } = methods["sessions.history"];
    expect(params.safeParse({ sessionId: "s", before: "e1", limit: 100 }).success).toBe(true);
    expect(params.safeParse({ sessionId: "s", before: "e1" }).success).toBe(true);
    for (const bad of [
      { before: "" },
      { before: "e".repeat(129) },
      { before: "e1", limit: 0 },
      { before: "e1", limit: 101 },
    ]) {
      expect(params.safeParse({ sessionId: "s", ...bad }).success).toBe(false);
    }
    const tool = methods["sessions.toolOutput"].params;
    expect(tool.safeParse({ sessionId: "s", toolCallId: "c".repeat(256) }).success).toBe(true);
    expect(tool.safeParse({ sessionId: "s", toolCallId: "c".repeat(257) }).success).toBe(false);
    expect(tool.safeParse({ sessionId: "s", toolCallId: "" }).success).toBe(false);
  });
});
