import { describe, expect, it } from "vitest";
import type { AuditPort } from "../audit/index.ts";
import { captureLogger } from "./testing/helpers.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { outsideToolResultsTaint } from "./outside-taint.ts";

type AuditLine = Parameters<AuditPort["append"]>[0];

const setup = (known = true) => {
  const policy = fakePolicyPort();
  const audited: AuditLine[] = [];
  const { logger, lines } = captureLogger();
  const taint = outsideToolResultsTaint({
    store: { get: (id) => (known && id === "s1" ? ({ id, ownerId: "u1" } as never) : undefined) },
    policy,
    audit: { append: (line) => void audited.push(line) },
    logger,
  });
  return { policy, audited, lines, taint };
};

describe("outsideToolResultsTaint (M7R27, M7R28)", () => {
  it("taints the session, logs it and audits it once", () => {
    const { policy, audited, lines, taint } = setup();
    taint("s1");
    expect(policy.sessionPolicy("u1", "s1").taint.tainted).toBe(true);
    expect(lines.filter((l) => l.msg === "session_tainted_outside")).toMatchObject([{ sessionId: "s1" }]);
    expect(audited).toEqual([
      { ownerId: "u1", actor: "system", kind: "policy", reason: "tainted_outside", sessionId: "s1" },
    ]);
  });

  it("raises without an observed epoch, so a late outside write after a Clear taints again (M7R28)", () => {
    const { policy, taint } = setup();
    const seen: Array<number | undefined> = [];
    const raise = policy.markTainted;
    policy.markTainted = (owner, id, epoch) => {
      seen.push(epoch);
      return raise(owner, id, epoch);
    };
    taint("s1");
    expect(seen).toEqual([undefined]);
  });

  it("says nothing more for a session that is tainted already", () => {
    const { audited, lines, taint } = setup();
    taint("s1");
    taint("s1");
    expect(audited).toHaveLength(1);
    expect(lines.filter((l) => l.msg === "session_tainted_outside")).toHaveLength(1);
  });

  it("does nothing for a session the table does not know", () => {
    const { policy, audited, taint } = setup(false);
    taint("s1");
    expect(policy.sessionPolicy("u1", "s1").taint.tainted).toBe(false);
    expect(audited).toEqual([]);
  });

  it("lets a failing policy reach the caller and audits nothing", () => {
    const { audited, taint, policy } = setup();
    policy.markTainted = () => {
      throw new Error("db down");
    };
    expect(() => taint("s1")).toThrow("db down");
    expect(audited).toEqual([]);
  });
});
