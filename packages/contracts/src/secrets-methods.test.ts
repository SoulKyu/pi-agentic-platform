import { describe, expect, it } from "vitest";
import { methods, TOKEN_PERMISSIONS } from "./index.ts";

const agentId = "atlas-1a2b";

describe("secrets methods (M11R85)", () => {
  it("are browser only: no token permission reaches them", () => {
    for (const name of ["secrets.list", "secrets.set", "secrets.delete"] as const)
      expect(TOKEN_PERMISSIONS).not.toContain(methods[name].permission);
  });

  it("list is an idempotent read, set and delete are mutations", () => {
    expect(methods["secrets.list"]).toMatchObject({ permission: "secrets:read", idempotent: true });
    expect(methods["secrets.set"]).toMatchObject({ permission: "secrets:admin", idempotent: false });
    expect(methods["secrets.delete"]).toMatchObject({ permission: "secrets:admin", idempotent: false });
  });

  it("set's receipt selector is the agent and the name, never the value (RT-03)", () => {
    expect(methods["secrets.set"].sensitiveParams).toEqual(["agentId", "name"]);
  });

  it("refuses hijack names, bad values and unknown fields at decode", () => {
    const ok = { agentId, name: "API_TOKEN", value: "v" };
    const set = methods["secrets.set"].params;
    expect(set.safeParse(ok).success).toBe(true);
    for (const bad of [
      { name: "PATH" },
      { name: "LD_PRELOAD" },
      { name: "HTTPS_PROXY" },
      { name: "lower" },
      { value: "" },
      { value: "x".repeat(4097) },
      { value: "a\0b" },
      { agentId: "../x" },
      { extra: 1 },
    ])
      expect(set.safeParse({ ...ok, ...bad }).success, JSON.stringify(Object.keys(bad))).toBe(false);
    expect(set.safeParse({ ...ok, value: "x".repeat(4096) }).success).toBe(true);
    expect(methods["secrets.delete"].params.safeParse({ agentId, name: "PATH" }).success).toBe(false);
  });

  it("declares the codes a caller handles", () => {
    expect(methods["secrets.set"].errors).toEqual(
      expect.arrayContaining(["not_found", "bad_request", "limit_reached", "internal"]),
    );
    expect(methods["secrets.delete"].errors).toContain("not_found");
    expect(methods["secrets.list"].errors).toContain("not_found");
  });

  it("list carries names and times, and a state; never a value field", () => {
    const result = methods["secrets.list"].result;
    expect(result.safeParse({ entries: [{ name: "API_TOKEN", updatedAt: 5 }], state: "ok" }).success).toBe(
      true,
    );
    expect(
      result.safeParse({ entries: [{ name: "API_TOKEN", updatedAt: 5, value: "x" }], state: "ok" }).success,
    ).toBe(false);
    expect(result.safeParse({ entries: [], state: "weird" }).success).toBe(false);
  });
});
