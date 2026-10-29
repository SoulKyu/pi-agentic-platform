import { describe, expect, it } from "vitest";
import { createLogRing } from "./log-ring.ts";

describe("createLogRing", () => {
  it("keeps the last 200 of 201 lines", () => {
    const ring = createLogRing();
    for (let n = 1; n <= 201; n++) ring.write(`line ${n}\n`);
    const lines = ring.lines();
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe("line 2");
    expect(lines.at(-1)).toBe("line 201");
  });

  it("flushes a line at 512 characters instead of growing it", () => {
    const ring = createLogRing();
    ring.write(`${"a".repeat(600)}\n`);
    expect(ring.lines()).toEqual(["a".repeat(512), "a".repeat(88)]);
    ring.write("b".repeat(1500));
    expect(ring.lines().map((line) => line.length)).toEqual([512, 88, 512, 512]);
  });

  it("flushes a partial line on request, and holds it back until then", () => {
    const ring = createLogRing();
    ring.write("no newline yet");
    expect(ring.lines()).toEqual([]);
    ring.flush();
    expect(ring.lines()).toEqual(["no newline yet"]);
    ring.flush();
    expect(ring.lines()).toEqual(["no newline yet"]);
  });

  it("joins a line split across chunks, strips a carriage return and keeps a split multibyte character whole", () => {
    const ring = createLogRing();
    const bytes = Buffer.from("héllo\r\nwörld\n");
    ring.write(bytes.subarray(0, 2));
    ring.write(bytes.subarray(2, 9));
    ring.write(bytes.subarray(9));
    expect(ring.lines()).toEqual(["héllo", "wörld"]);
  });

  it("keeps stdout and stderr partial lines apart", () => {
    const ring = createLogRing();
    ring.write("out-", 1);
    ring.write("err-", 2);
    ring.write("done\n", 1);
    ring.write("done\n", 2);
    expect(ring.lines()).toEqual(["out-done", "err-done"]);
  });

  it("does not cut a surrogate pair at the 512 boundary", () => {
    const ring = createLogRing();
    ring.write(`${"a".repeat(511)}\u{1F600}\n`);
    const lines = ring.lines();
    expect(lines).toEqual(["a".repeat(511), "\u{1F600}"]);
  });
});
