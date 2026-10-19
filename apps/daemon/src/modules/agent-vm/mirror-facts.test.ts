import { closeSync, constants, openSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMirrorFacts, scanMirror, unverifiedIds, unverifiedPathOf } from "./mirror-facts.ts";
import { type Bed, entry, HEADER, imageEntry, makeBed } from "./mirror-fixtures.ts";

let bed: Bed;
const fresh = () => (bed = makeBed());
afterEach(() => bed.dispose());

const scan = (path: string) => {
  const fd = openSync(path, constants.O_RDWR);
  try {
    return scanMirror(fd);
  } finally {
    closeSync(fd);
  }
};

describe("readMirrorFacts (Review Focus 5)", () => {
  it("is empty for a file that does not exist yet", () => {
    fresh();
    expect(readMirrorFacts(bed.path)).toEqual({ size: 0, lastEntryId: null });
  });

  it("answers the header's id for a header-only file, as the worker does", () => {
    fresh();
    writeFileSync(bed.path, HEADER);
    expect(readMirrorFacts(bed.path)).toEqual({ size: HEADER.length, lastEntryId: "hdr00001" });
  });

  it("gives the size and the id of the last complete entry", () => {
    fresh();
    writeFileSync(bed.path, HEADER + entry("e1") + entry("e2"));
    expect(readMirrorFacts(bed.path)).toEqual({
      size: HEADER.length + entry("e1").length + entry("e2").length,
      lastEntryId: "e2",
    });
  });

  it("cuts a partial last line (a crash mid-write) at open: the file ends with a newline again", () => {
    fresh();
    const whole = HEADER + entry("e1");
    writeFileSync(bed.path, `${whole}{"type":"message","id":"e2","par`);
    expect(readMirrorFacts(bed.path)).toEqual({ size: whole.length, lastEntryId: "e1" });
    expect(statSync(bed.path).size).toBe(whole.length);
    expect(readFileSync(bed.path, "utf8").endsWith("\n")).toBe(true);
  });

  it("cuts a file that is nothing but a partial line to empty", () => {
    fresh();
    writeFileSync(bed.path, '{"type":"sess');
    expect(readMirrorFacts(bed.path)).toEqual({ size: 0, lastEntryId: null });
    expect(statSync(bed.path).size).toBe(0);
  });

  it("refuses a link at the file (O_NOFOLLOW)", () => {
    fresh();
    const target = join(bed.root, "target.jsonl");
    writeFileSync(target, HEADER);
    symlinkSync(target, bed.path);
    expect(() => readMirrorFacts(bed.path)).toThrow();
  });
});

describe("scanMirror: ids come from each line's first 512 bytes, else the line is parsed", () => {
  it("lists the header's id and every entry's id", () => {
    fresh();
    writeFileSync(bed.path, HEADER + entry("e1") + entry("e2"));
    expect([...scan(bed.path).ids].sort()).toEqual(["e1", "e2", "hdr00001"]);
  });

  it("reads the id of a line from its head even when the line is far over the inline bound", () => {
    fresh();
    writeFileSync(bed.path, HEADER + imageEntry("img1", 3 * 1024 * 1024) + entry("e2"));
    const scanned = scan(bed.path);
    expect(scanned.ids.has("img1")).toBe(true);
    expect(scanned.lastEntryId).toBe("e2");
  });

  it("parses a line whose id is not in the head", () => {
    fresh();
    const late = `${JSON.stringify({ type: "custom", pad: "x".repeat(700), id: "late1" })}\n`;
    const idFirst = `${JSON.stringify({ id: "first1", type: "custom" })}\n`;
    writeFileSync(bed.path, HEADER + late + idFirst);
    const scanned = scan(bed.path);
    expect(scanned.ids.has("late1")).toBe(true);
    expect(scanned.ids.has("first1")).toBe(true);
    expect(scanned.lastEntryId).toBe("first1");
  });

  it("finds a line split across read blocks", () => {
    fresh();
    writeFileSync(bed.path, HEADER + imageEntry("big1", 2_500_000) + imageEntry("big2", 1_500_000));
    expect([...scan(bed.path).ids].sort()).toEqual(["big1", "big2", "hdr00001"]);
  });
});

describe("unverifiedIds (R32)", () => {
  it("is empty without a sidecar", () => {
    fresh();
    expect(unverifiedIds(bed.path).size).toBe(0);
  });

  it("lists the ids of the sidecar next to the file", () => {
    fresh();
    expect(unverifiedPathOf(bed.path)).toBe(`${bed.path}.unverified`);
    writeFileSync(unverifiedPathOf(bed.path), "u1\nu2\n\n");
    expect([...unverifiedIds(bed.path)].sort()).toEqual(["u1", "u2"]);
  });

  it("does not follow a link at the sidecar", () => {
    fresh();
    const target = join(bed.root, "other");
    writeFileSync(target, "u1\n");
    symlinkSync(target, unverifiedPathOf(bed.path));
    expect(unverifiedIds(bed.path).size).toBe(0);
  });
});
