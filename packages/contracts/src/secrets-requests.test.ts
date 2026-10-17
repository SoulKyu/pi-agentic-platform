import { describe, expect, it } from "vitest";
import {
  methods,
  DaemonToWorker,
  parseWorkerRecord,
  PLATFORM_RESULTS,
  SecretUsedRecord,
  TOKEN_PERMISSIONS,
} from "./index.ts";

describe("secrets.answerRequest and declineRequest (M11R103)", () => {
  it("are browser only mutations", () => {
    for (const name of ["secrets.answerRequest", "secrets.declineRequest"] as const) {
      expect(TOKEN_PERMISSIONS).not.toContain(methods[name].permission);
      expect(methods[name]).toMatchObject({ permission: "secrets:admin", idempotent: false });
      expect(methods[name].errors).toEqual(expect.arrayContaining(["forbidden", "not_found", "read_only"]));
    }
  });

  it("the receipt hashes the selector fields, never the value (RT-03)", () => {
    expect(methods["secrets.answerRequest"].sensitiveParams).toEqual(["requestId", "mode"]);
    expect(methods["secrets.declineRequest"]).not.toHaveProperty("sensitiveParams");
  });

  it("decodes a request id, a vault value and a mode, and nothing else", () => {
    const params = methods["secrets.answerRequest"].params;
    const ok = { requestId: "r1", value: "v", mode: "once" };
    expect(params.safeParse(ok).success).toBe(true);
    expect(params.safeParse({ ...ok, mode: "vault" }).success).toBe(true);
    for (const bad of [
      { mode: "forever" },
      { value: "" },
      { value: "a\0b" },
      { value: "x".repeat(4097) },
      { requestId: "" },
      { requestId: "r".repeat(65) },
      { extra: 1 },
    ])
      expect(params.safeParse({ ...ok, ...bad }).success, JSON.stringify(Object.keys(bad))).toBe(false);
    expect(methods["secrets.answerRequest"].errors).toContain("limit_reached");
  });

  it("the result of an answer carries nothing", () => {
    expect(methods["secrets.answerRequest"].result.safeParse({}).success).toBe(true);
    expect(methods["secrets.answerRequest"].result.safeParse({ value: "x" }).success).toBe(false);
  });
});

describe("secret_used (M11R105)", () => {
  it("is a worker record with a vault name and nothing else", () => {
    expect(parseWorkerRecord({ type: "secret_used", name: "API_TOKEN", id: "i1" })).toEqual({
      type: "secret_used",
      name: "API_TOKEN",
      id: "i1",
    });
    expect(SecretUsedRecord.safeParse({ type: "secret_used", name: "API_TOKEN", id: "i1" }).success).toBe(
      true,
    );
  });

  it("is dropped, never forwarded as a Pi event, when malformed", () => {
    expect(parseWorkerRecord({ type: "secret_used", name: "PATH" })).toBeNull();
    expect(parseWorkerRecord({ type: "secret_used", name: "lower" })).toBeNull();
    expect(parseWorkerRecord({ type: "secret_used", name: "API_TOKEN" })).toBeNull();
    expect(parseWorkerRecord({ type: "secret_used", name: "API_TOKEN", value: "x" })).toBeNull();
  });

  it("a secret.request result has the ref's fixed format and no value field", () => {
    const result = PLATFORM_RESULTS["secret.request"];
    const ok = { ref: `secret-ref:${"a1".repeat(16)}`, name: "API_TOKEN", mode: "once" };
    expect(result.safeParse(ok).success).toBe(true);
    expect(result.safeParse({ ...ok, value: "x" }).success).toBe(false);
    expect(result.safeParse({ ...ok, ref: "secret-ref:abc" }).success).toBe(false);
  });
});

describe("vault_update.once carries the daemon's expiry (W5-R37)", () => {
  const update = (once: unknown) => ({ type: "vault_update", vault: {}, once });
  it("needs name, value and a whole non-negative expiresAt on every item, and at most three", () => {
    const item = { id: "i1", name: "API_TOKEN", value: "v", expiresAt: 5 };
    expect(DaemonToWorker.safeParse(update([item])).success).toBe(true);
    for (const bad of [
      { name: "API_TOKEN", value: "v", expiresAt: 5 },
      { ...item, id: "" },
      { ...item, expiresAt: -1 },
      { ...item, expiresAt: 1.5 },
      { ...item, extra: 1 },
    ])
      expect(DaemonToWorker.safeParse(update([bad])).success).toBe(false);
    expect(DaemonToWorker.safeParse(update([item, item, item, item])).success).toBe(false);
  });
});
