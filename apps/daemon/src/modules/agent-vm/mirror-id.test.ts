import { describe, expect, it } from "vitest";
import { createIdScanner, topLevelIdOf } from "./mirror-id.ts";

const id = (text: string) => topLevelIdOf(Buffer.from(text));

// Mutants (AVM-E27), each run for real:
// - M-NESTED-TAKEN: depth is not tracked (an `id` inside `data` is taken or confuses the count): killed by "nested".
// - M-DUP-ACCEPTED: the last top-level `id` wins (JSON.parse's rule): killed by "two top-level ids".
// - M-ESCAPED-KEY-ACCEPTED (mirror.test.ts): a null scan is taken as agreeing with the parse: killed by the escaped-key case there.
describe("topLevelIdOf (AVM-E27)", () => {
  it("finds the id wherever the key sits in the object", () => {
    expect(id('{"type":"message","id":"a1b2c3d4","parentId":null}')).toBe("a1b2c3d4");
    expect(id('{"type":"custom","customType":"x","data":{"k":1},"id":"c1","parentId":"p"}')).toBe("c1");
    expect(id('{"id":"first1","type":"custom"}')).toBe("first1");
    expect(id('{ "type" : "x" , "id" : "sp1" }')).toBe("sp1");
    expect(
      id(
        '{"type":"custom_message","customType":"x","content":"c","display":true,"details":{"a":[1,2]},"id":"d1"}',
      ),
    ).toBe("d1");
  });

  it("does not take an id nested in an object or an array", () => {
    expect(id('{"type":"custom","data":{"k":1,"id":"nested"},"id":"real1"}')).toBe("real1");
    expect(id('{"type":"custom","data":[{"id":"n1"},{"id":"n2"}],"id":"real2"}')).toBe("real2");
    expect(id('{"type":"custom","data":{"id":"nested"}}')).toBeNull();
    expect(id('{"data":{"deep":{"id":"x","a":[{"id":"y"}]}},"id":"real3"}')).toBe("real3");
  });

  it("is null for two top-level ids (JSON.parse keeps the last)", () => {
    expect(id('{"type":"message","id":"e1x","id":"e1"}')).toBeNull();
    expect(id('{"id":"a","type":"m","id":"a"}')).toBeNull();
  });

  it("is null for an escaped key, however it spells id", () => {
    expect(id('{"type":"m","\\u0069d":"e9"}')).toBeNull();
    expect(id('{"type":"m","i\\u0064":"e9","id":"e8"}')).toBeNull();
    expect(id('{"type":"m","a\\nb":1,"id":"e8"}')).toBeNull();
  });

  it("is null when the value is not a plain id string", () => {
    expect(id('{"id":5}')).toBeNull();
    expect(id('{"id":null}')).toBeNull();
    expect(id('{"id":{"a":1}}')).toBeNull();
    expect(id('{"id":"a\\nb"}')).toBeNull();
    expect(id('{"id":"a b"}')).toBeNull();
    expect(id('{"id":""}')).toBeNull();
    expect(id(`{"id":"${"i".repeat(129)}"}`)).toBeNull();
    expect(id(`{"id":"${"i".repeat(128)}"}`)).toBe("i".repeat(128));
  });

  it("is null for no id and for what is not an object", () => {
    expect(id('{"type":"message"}')).toBeNull();
    expect(id('[{"id":"a"}]')).toBeNull();
    expect(id('"id"')).toBeNull();
    expect(id("")).toBeNull();
  });

  it("reads past strings with escaped quotes and backslashes", () => {
    expect(id('{"a":"x\\"y,\\"id\\":\\"fake\\"","id":"real"}')).toBe("real");
    expect(id('{"a":"ends with a backslash \\\\","id":"real"}')).toBe("real");
    expect(id('{"a":"\\\\\\"still inside","id":"fake"}')).toBe("fake");
  });

  it("is the same fed byte by byte or in any blocks, whatever the escapes", () => {
    const lines = [
      '{"type":"custom","data":{"k":1,"id":"nested"},"id":"real1"}',
      '{"a":"x\\"y,\\"id\\":\\"fake\\"","id":"real"}',
      '{"a":"\\\\","b":"\\\\\\\\\\"","id":"r2"}',
      '{"type":"m","id":"e1x","id":"e1"}',
      '{"type":"m","\\u0069d":"e9"}',
    ];
    for (const text of lines) {
      const whole = id(text);
      for (let size = 1; size <= 7; size++) {
        const scanner = createIdScanner();
        const bytes = Buffer.from(text);
        for (let at = 0; at < bytes.length; at += size) scanner.feed(bytes.subarray(at, at + size));
        expect(scanner.result(), `${size}: ${text}`).toBe(whole);
      }
    }
  });

  it("jumps over a long string body: a 30 MiB base64 image is not walked byte by byte", () => {
    const body = "A".repeat(30 * 1024 * 1024);
    const started = process.hrtime.bigint();
    expect(
      id(`{"type":"message","message":{"content":[{"type":"image","data":"${body}"}]},"id":"img1"}`),
    ).toBe("img1");
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(500);
  });
});
