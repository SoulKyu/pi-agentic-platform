import { describe, expect, it } from "vitest";
import { SandboxStatus } from "./agents-methods.ts";
import {
  EGRESS_LIMITS,
  EGRESS_REASONS,
  EgressClose,
  EgressHost,
  EgressOpen,
  EgressOpened,
  EgressReport,
  EgressStatus,
} from "./egress.ts";

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

  it("opens and closes a command by id, strictly", () => {
    expect(EgressOpen.parse({ type: "egress_open", id: "c1" })).toEqual({ type: "egress_open", id: "c1" });
    expect(EgressClose.parse({ type: "egress_close", id: "c1" })).toEqual({ type: "egress_close", id: "c1" });
    expect(EgressOpen.safeParse({ type: "egress_open", id: "c 1" }).success).toBe(false);
    expect(EgressOpen.safeParse({ type: "egress_open", id: "c1", extra: 1 }).success).toBe(false);
  });

  it("answers an open with a socket path or a reason, never both missing", () => {
    const socket = "/run/user/1000/pap/egress/1/0.s";
    expect(EgressOpened.parse({ type: "egress_opened", id: "c1", socket, reason: null }).socket).toBe(socket);
    expect(
      EgressOpened.parse({ type: "egress_opened", id: "c1", socket: null, reason: "limit" }).reason,
    ).toBe("limit");
    expect(
      EgressOpened.safeParse({ type: "egress_opened", id: "c1", socket: null, reason: null }).success,
    ).toBe(false);
    expect(EgressOpened.safeParse({ type: "egress_opened", id: "c1", socket, reason: "limit" }).success).toBe(
      false,
    );
    expect(
      EgressOpened.safeParse({ type: "egress_opened", id: "c1", socket: "relative.s", reason: null }).success,
    ).toBe(false);
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

  it("the status names why the proxy is unusable, and older views default to unusable", () => {
    expect(EgressStatus.parse({ usable: false, python: null, reason: "socket_path" }).reason).toBe(
      "socket_path",
    );
    expect(EgressStatus.safeParse({ usable: false, python: null, reason: "other" }).success).toBe(false);
    const older = SandboxStatus.parse({ usable: true, path: "/usr/bin/bwrap", reason: null, checkedAt: 1 });
    expect(older.egress).toEqual({ usable: false, python: null, reason: "no_python" });
  });
});
