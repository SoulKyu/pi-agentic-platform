import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readMirrorFacts,
  scanMirror,
  UNVERIFIED_MAX_BYTES,
  unverifiedIds,
  unverifiedPathOf,
} from "./mirror-facts.ts";
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

describe("scanMirror: the top-level id of each line, by a byte scan", () => {
  it("lists the header's id and every entry's id", () => {
    fresh();
    writeFileSync(bed.path, HEADER + entry("e1") + entry("e2"));
    expect([...scan(bed.path).ids].sort()).toEqual(["e1", "e2", "hdr00001"]);
  });

  it("reads the id of a line even when the line is far over the inline bound", () => {
    fresh();
    writeFileSync(bed.path, HEADER + imageEntry("img1", 3 * 1024 * 1024) + entry("e2"));
    const scanned = scan(bed.path);
    expect(scanned.ids.has("img1")).toBe(true);
    expect(scanned.lastEntryId).toBe("e2");
  });

  // Mutant M-OPEN-PARSE: parse (or fall back to parsing) a line at open: killed by the spy, which sees no parse at all.
  it("never parses anything at open, whatever the line: ids come from the byte scan (AVM-E27)", () => {
    fresh();
    const custom = `${JSON.stringify({ type: "custom", customType: "x", data: { id: "nested" }, id: "c1" })}\n`;
    const late = `${JSON.stringify({ type: "custom", pad: "x".repeat(700), id: "late1" })}\n`;
    writeFileSync(bed.path, HEADER + imageEntry("img1", 3 * 1024 * 1024) + custom + late + entry("e2"));
    const parse = vi.spyOn(JSON, "parse");
    try {
      const scanned = scan(bed.path);
      expect(parse).not.toHaveBeenCalled();
      expect([...scanned.ids].sort()).toEqual(["c1", "e2", "hdr00001", "img1", "late1"]);
      expect(scanned.lastEntryId).toBe("e2");
    } finally {
      parse.mockRestore();
    }
  });

  it("throws past the cap on ids (AVM-E23)", () => {
    fresh();
    const lines = Array.from({ length: 6 }, (_, i) => entry(`e${i}`)).join("");
    writeFileSync(bed.path, HEADER + lines);
    const fd = openSync(bed.path, constants.O_RDWR);
    try {
      expect(scanMirror(fd, 7).ids.size).toBe(7);
      expect(() => scanMirror(fd, 6)).toThrow(/too many/);
    } finally {
      closeSync(fd);
    }
  });

  it("finds a line split across read blocks", () => {
    fresh();
    writeFileSync(bed.path, HEADER + imageEntry("big1", 2_500_000) + imageEntry("big2", 1_500_000));
    expect([...scan(bed.path).ids].sort()).toEqual(["big1", "big2", "hdr00001"]);
  });
});

describe("unverifiedIds (R32, AVM-E22)", () => {
  it("is empty and trusted without a sidecar", () => {
    fresh();
    expect(unverifiedIds(bed.path)).toEqual({ ids: new Set(), all: false });
  });

  it("lists the ids of the sidecar next to the file", () => {
    fresh();
    expect(unverifiedPathOf(bed.path)).toBe(`${bed.path}.unverified`);
    writeFileSync(unverifiedPathOf(bed.path), "u1\nu2\n");
    const listed = unverifiedIds(bed.path);
    expect([...listed.ids].sort()).toEqual(["u1", "u2"]);
    expect(listed.all).toBe(false);
  });

  // Mutant M-SIDECAR-OPEN: an unreadable list is an empty one (fail open): killed by the next three cases.
  it("marks everything when the sidecar is a link", () => {
    fresh();
    const target = join(bed.root, "other");
    writeFileSync(target, "u1\n");
    symlinkSync(target, unverifiedPathOf(bed.path));
    expect(unverifiedIds(bed.path)).toEqual({ ids: new Set(), all: true });
  });

  it("marks everything when the sidecar is not readable or is over its bound", () => {
    fresh();
    writeFileSync(unverifiedPathOf(bed.path), Buffer.alloc(UNVERIFIED_MAX_BYTES + 1, 0x61));
    expect(unverifiedIds(bed.path).all).toBe(true);
    rmSync(unverifiedPathOf(bed.path));
    mkdirSync(unverifiedPathOf(bed.path));
    expect(unverifiedIds(bed.path).all).toBe(true);
  });
});
