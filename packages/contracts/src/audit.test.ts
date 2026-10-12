import { describe, expect, it } from "vitest";
import { AUDIT_ACTORS, AUDIT_KINDS, AuditView, methods } from "./index.ts";

const view = {
  id: 1,
  at: 1_700_000_000_000,
  actor: "worker",
  actorId: null,
  kind: "call",
  sessionId: "s1",
  toolCallId: "c1",
  parentToolCallId: null,
  tool: "bash",
  category: "exec",
  decision: "allow",
  reason: null,
  stages: [{ stage: "01", outcome: "pass" }],
  args: "ls",
  detail: null,
} as const;

describe("audit contract", () => {
  it("declares audit.list as an idempotent audit:read query with a bounded limit", () => {
    const def = methods["audit.list"];
    expect(def).toMatchObject({ permission: "audit:read", idempotent: true, errors: [] });
    expect(def.params.safeParse({}).success).toBe(true);
    expect(def.params.safeParse({ limit: 200, before: 5, sessionId: "s" }).success).toBe(true);
    for (const bad of [{ limit: 0 }, { limit: 201 }, { before: 0 }, { sessionId: "" }, { limit: 1.5 }]) {
      expect(def.params.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts a view, refuses an unknown actor or kind, and caps a page at 200 entries", () => {
    expect(AuditView.safeParse(view).success).toBe(true);
    expect(AuditView.safeParse({ ...view, actor: "root" }).success).toBe(false);
    expect(AuditView.safeParse({ ...view, kind: "other" }).success).toBe(false);
    const def = methods["audit.list"];
    const page = (n: number) => ({ entries: Array(n).fill(view), nextBefore: null, truncated: false });
    expect(def.result.safeParse(page(200)).success).toBe(true);
    expect(def.result.safeParse(page(201)).success).toBe(false);
    expect(AUDIT_ACTORS).toEqual(["worker", "user", "token", "cli", "system"]);
    expect(AUDIT_KINDS).toEqual(["call", "result", "session", "invalid", "auth", "policy", "audit"]);
  });
});
