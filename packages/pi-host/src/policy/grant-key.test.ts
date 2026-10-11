import { describe, expect, it } from "vitest";
import { grantKey, grantPayload } from "./grant-key.ts";

describe("grant keys", () => {
  it("are the same for the same exact call and differ for any other", () => {
    const ls = grantKey("bash", grantPayload({ command: "ls -la" }, true));
    expect(ls).toMatch(/^[0-9a-f]{64}$/);
    expect(grantKey("bash", grantPayload({ command: "ls -la", timeout: 5 }, true))).toBe(ls);
    expect(grantKey("bash", grantPayload({ command: "ls  -la" }, true))).not.toBe(ls);
    expect(grantKey("bash", grantPayload({ command: "ls -la​" }, true))).not.toBe(ls);
    expect(grantKey("other", grantPayload({ command: "ls -la" }, true))).not.toBe(ls);
  });

  it("ignore the order of object keys for other tools, at any depth, and leave out undefined", () => {
    expect(grantKey("fetch", grantPayload({ url: "https://a", method: "GET" }, false))).toBe(
      grantKey("fetch", grantPayload({ method: "GET", url: "https://a" }, false)),
    );
    expect(grantKey("t", grantPayload({ a: { y: 1, x: [2, { d: 1, c: 2 }] }, b: undefined }, false))).toBe(
      grantKey("t", grantPayload({ a: { x: [2, { c: 2, d: 1 }], y: 1 } }, false)),
    );
    expect(grantKey("t", grantPayload({ a: [1, 2] }, false))).not.toBe(
      grantKey("t", grantPayload({ a: [2, 1] }, false)),
    );
  });

  it("never let a command string stand for a JSON payload, nor a tool name swallow a separator (M2-RT-24)", () => {
    const asCommand = grantKey("t", { kind: "cmd", payload: '{"a":1}' });
    expect(grantKey("t", grantPayload({ a: 1 }, false))).not.toBe(asCommand);
    expect(grantKey("t\u0000cmd", { kind: "json", payload: "x" })).not.toBe(
      grantKey("t", { kind: "cmd", payload: "x" }),
    );
    expect(grantKey('t","cmd', { kind: "json", payload: "x" })).not.toBe(
      grantKey("t", { kind: "cmd", payload: "x" }),
    );
    expect(grantKey("t", { kind: "json", payload: 'x","cmd' })).not.toBe(
      grantKey("t", { kind: "cmd", payload: "x" }),
    );
  });

  it("uses the json kind for an exec tool without a string command", () => {
    expect(grantPayload({ command: 5 }, true)).toEqual({ kind: "json", payload: '{"command":5}' });
    expect(grantPayload(null, true)).toEqual({ kind: "json", payload: "{}" });
    expect(grantPayload({ command: "ls" }, false).kind).toBe("json");
  });

  it("refuse an input too deep, too large or not plain data, so the call fails closed", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { a: deep };
    expect(() => grantPayload(deep, false)).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => grantPayload(cycle, false)).toThrow();
    expect(() => grantPayload({ big: "x".repeat(3 * 1024 * 1024) }, false)).toThrow();
    expect(() =>
      grantPayload(
        Array.from({ length: 1_000_000 }, () => "abcd"),
        false,
      ),
    ).toThrow();
    expect(() => grantPayload({ n: 1n }, false)).toThrow();
    expect(() => grantPayload(() => 1, false)).toThrow();
  });
});
