import { describe, expect, it } from "vitest";
import { EGRESS_LIMITS, EGRESS_REASONS, EgressHost, EgressReport } from "./egress.ts";

const host = { host: "api.example.com", port: 443, kind: "connect", verdict: "allowed" } as const;

describe("the egress records", () => {
  it("pins the limits the proxy enforces (M11R236)", () => {
    expect(EGRESS_LIMITS).toMatchObject({
      connections: 32,
      bytes: 1024 ** 3,
      headBytes: 16 * 1024,
      headMs: 10_000,
      idleMs: 120_000,
      connectionMs: 30 * 60_000,
      commandsPerSession: 8,
      upstream: 256,
      hosts: 64,
      logHosts: 16,
      resolveMs: 5_000,
      connectMs: 10_000,
    });
  });

  it("caps a report at 64 hosts and refuses a negative count", () => {
    const base = { type: "egress_report", id: "c1", truncated: false, up: 1, down: 2 } as const;
    expect(EgressReport.safeParse({ ...base, hosts: Array.from({ length: 64 }, () => host) }).success).toBe(
      true,
    );
    expect(EgressReport.safeParse({ ...base, hosts: Array.from({ length: 65 }, () => host) }).success).toBe(
      false,
    );
    expect(EgressReport.safeParse({ ...base, hosts: [], up: -1 }).success).toBe(false);
  });

  it("a host entry carries a known reason only", () => {
    expect(EgressHost.safeParse({ ...host, verdict: "refused", reason: "not_listed" }).success).toBe(true);
    expect(EgressHost.safeParse({ ...host, verdict: "refused", reason: "whatever" }).success).toBe(false);
    expect(EGRESS_REASONS).toContain("blocked_ip");
  });
});
