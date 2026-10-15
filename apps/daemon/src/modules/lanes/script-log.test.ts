import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CUT_LINE, readLog, utf8Keep } from "./script-log.ts";
import { tempHome } from "./testing/script-fakes.ts";

let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home.dispose());

const KIB = 1024;
const write = (laneId: string, kind: string, data: Buffer | string): void => {
  mkdirSync(join(home.dir, "lanes", laneId), { recursive: true });
  writeFileSync(join(home.dir, "lanes", laneId, `${kind}.log`), data);
};
const deps = () => ({ home: home.dir, ownerOf: (id: string) => (id === "lane-aaaa" ? "u1" : undefined) });

describe("readLog (M9R29)", () => {
  it("reads 256 KiB chunks from an offset; nextOffset is null at the end", () => {
    write("lane-aaaa", "setup", "a".repeat(600 * KIB));
    const first = readLog(deps(), "u1", "lane-aaaa", "setup", 0);
    expect(first.text).toHaveLength(256 * KIB);
    expect(first.nextOffset).toBe(256 * KIB);
    expect(first.size).toBe(600 * KIB);
    const second = readLog(deps(), "u1", "lane-aaaa", "setup", first.nextOffset ?? -1);
    expect(second.nextOffset).toBe(512 * KIB);
    const third = readLog(deps(), "u1", "lane-aaaa", "setup", second.nextOffset ?? -1);
    expect(third.text).toHaveLength(88 * KIB);
    expect(third.nextOffset).toBeNull();
    expect(third.capped).toBe(false);
  });

  it("cuts back to the start of a multi-byte character at the chunk end", () => {
    // 256 KiB - 1 bytes of "a", then a 3-byte character straddling the limit.
    write("lane-aaaa", "setup", Buffer.from("a".repeat(256 * KIB - 1) + "€€"));
    const first = readLog(deps(), "u1", "lane-aaaa", "setup", 0);
    expect(first.text).toBe("a".repeat(256 * KIB - 1));
    expect(first.nextOffset).toBe(256 * KIB - 1);
    const second = readLog(deps(), "u1", "lane-aaaa", "setup", first.nextOffset ?? -1);
    expect(second.text).toBe("€€");
    expect(second.nextOffset).toBeNull();
  });

  it("starts at the next character when the offset falls inside one", () => {
    write("lane-aaaa", "setup", "x€y");
    expect(readLog(deps(), "u1", "lane-aaaa", "setup", 2).text).toBe("y");
  });

  it("reports capped for a cut log", () => {
    write("lane-aaaa", "setup", `data\n${CUT_LINE}\n`);
    expect(readLog(deps(), "u1", "lane-aaaa", "setup", 0).capped).toBe(true);
  });

  it("answers not_found for another owner's lane and for no lane, and empty for no log yet", () => {
    write("lane-aaaa", "setup", "x");
    expect(() => readLog(deps(), "u2", "lane-aaaa", "setup", 0)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => readLog(deps(), "u1", "lane-zzzz", "setup", 0)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(readLog(deps(), "u1", "lane-aaaa", "test", 0)).toEqual({
      text: "",
      nextOffset: null,
      size: 0,
      capped: false,
    });
  });

  it("refuses a lane id that is not a plain segment", () => {
    const evil = { home: home.dir, ownerOf: () => "u1" };
    expect(() => readLog(evil, "u1", "../../etc", "setup", 0)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
  });
});

describe("utf8Keep", () => {
  it("keeps a complete end and drops an incomplete character", () => {
    expect(utf8Keep(Buffer.from("ab€"))).toBe(5);
    expect(utf8Keep(Buffer.from("ab€").subarray(0, 4))).toBe(2);
    expect(utf8Keep(Buffer.from("ab😀").subarray(0, 5))).toBe(2);
  });
});
