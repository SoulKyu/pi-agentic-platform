import { describe, expect, it } from "vitest";
import { ERROR_CODES, METHOD_IDEMPOTENT, methods } from "./index.ts";

const PUSH = [
  ["push.config", "settings:read", true],
  ["push.subscribe", "settings:operate", false],
  ["push.list", "settings:read", true],
  ["push.revoke", "settings:operate", false],
  ["push.test", "settings:operate", false],
  ["push.presence", "settings:read", true],
  ["push.open", "settings:read", true],
] as const;

describe("push methods (task 1)", () => {
  it("has the seven names with their permission and idempotency", () => {
    const names = Object.keys(methods).filter((name) => name.startsWith("push."));
    expect(names.sort()).toEqual(PUSH.map(([name]) => name).sort());
    for (const [name, permission, idempotent] of PUSH) {
      const def = methods[name];
      expect(def.permission, name).toBe(permission);
      expect(def.idempotent, name).toBe(idempotent);
      expect(METHOD_IDEMPOTENT[name], name).toBe(idempotent);
    }
  });

  it("declares only error codes that exist, and push_unavailable where the brief says", () => {
    for (const [name] of PUSH) {
      for (const code of methods[name].errors) expect(ERROR_CODES, `${name} ${code}`).toContain(code);
    }
    expect(methods["push.subscribe"].errors).toEqual(
      expect.arrayContaining([
        "bad_request",
        "capacity",
        "conflict",
        "forbidden",
        "rate_limited",
        "push_unavailable",
        "read_only",
      ]),
    );
    expect(methods["push.test"].errors).toEqual(
      expect.arrayContaining(["rate_limited", "push_unavailable", "forbidden"]),
    );
    expect(methods["push.presence"].errors).toEqual(expect.arrayContaining(["capacity", "forbidden"]));
    expect(methods["push.revoke"].errors).toEqual(expect.arrayContaining(["not_found", "forbidden"]));
    expect(methods["push.open"].errors).toEqual(expect.arrayContaining(["not_found", "forbidden"]));
  });

  it("checks the shapes of the params and results", () => {
    expect(methods["push.presence"].params.safeParse({ focused: true }).success).toBe(true);
    expect(methods["push.presence"].params.safeParse({ focused: "yes" }).success).toBe(false);
    expect(methods["push.open"].params.safeParse({ id: "abcdefghijklmnopqrstuv" }).success).toBe(true);
    expect(methods["push.open"].params.safeParse({ id: "short" }).success).toBe(false);
    expect(methods["push.revoke"].params.safeParse({ id: "x" }).success).toBe(true);
    const config = {
      publicKey: null,
      status: "off",
      reason: null,
      readiness: { status: "ready" },
      subscribed: 0,
      max: 10,
      lastFailure: null,
      keysReset: null,
    };
    expect(methods["push.config"].result.safeParse(config).success).toBe(true);
    expect(methods["push.config"].result.safeParse({ ...config, reason: "other" }).success).toBe(false);
    const item = {
      id: "i",
      label: "Phone",
      host: "fcm.googleapis.com",
      createdAt: 1,
      lastOkAt: null,
      current: true,
    };
    expect(methods["push.list"].result.safeParse({ items: [item] }).success).toBe(true);
    expect(
      methods["push.list"].result.safeParse({ items: [{ ...item, endpoint: "https://x" }] }).success,
    ).toBe(false);
  });
});
