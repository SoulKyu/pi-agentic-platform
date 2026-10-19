import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeMirrorFiles } from "./mirror-facts.ts";
import { appendOf, entry, HEADER, imageEntry, userEntry, writeMirror } from "./mirror-fixtures.ts";
import {
  announced,
  bed,
  cleanup,
  fileText,
  fresh,
  keptFiles,
  MiB,
  open,
  refusals,
} from "./mirror-harness.ts";
import type { ReadAt } from "./mirror-index.ts";
import { readSync } from "node:fs";

afterEach(cleanup);

const counting = () => {
  const reads = { bytes: 0, calls: 0 };
  const read: ReadAt = (fd, buffer, offset, length, position) => {
    const got = readSync(fd, buffer, offset, length, position);
    reads.bytes += got;
    reads.calls++;
    return got;
  };
  return { reads, read };
};
const indexFile = () => `${bed.path}.ids`;

// Mutants (AVM-E29), each run for real:
// - M-OPEN-SCANS: open scans the mirror's lines instead of reading the index: killed by "reads a few KB".
// - M-INDEX-PAST-SIZE: index entries past the file are taken: killed by "a crash between the index write and the line write".
// - M-INDEX-NOT-INCREASING (below): the order of the ends is not checked: killed by the malformed-index cases.
describe("the open reads the id index, not the transcript (AVM-E29)", () => {
  it("reads a few KB of a 22 MiB mirror, and still knows every id and the last entry", async () => {
    fresh();
    const first = open();
    const text =
      HEADER + imageEntry("img1", 10 * MiB) + entry("e2") + imageEntry("img3", 10 * MiB) + entry("e4");
    const bytes = Buffer.from(text);
    for (let at = 0; at < bytes.length; at += 2 * MiB)
      expect(await first.onSessionAppend(appendOf(at, bytes.subarray(at, at + 2 * MiB)))).toBe("ok");
    first.close();
    const { reads, read } = counting();
    const again = open({ read });
    expect(again.facts()).toEqual({ size: bytes.length, lastEntryId: "e4" });
    expect(reads.bytes).toBeLessThan(16 * 1024);
    expect(await again.onSessionAppend(appendOf(bytes.length, entry("img1")))).toBe("refused");
    expect(refusals().at(-1)?.reason).toBe("duplicate_id");
  });

  it("writes one `<lineEnd> <id>` record per line, before the line", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + entry("e1")));
    expect(readFileSync(indexFile(), "utf8")).toBe(
      `${HEADER.length} hdr00001\n${HEADER.length + entry("e1").length} e1\n`,
    );
    expect(statSync(indexFile()).mode & 0o777).toBe(0o600);
  });

  it("a crash between the index write and the line write leaves entries past the file, which are ignored and cut", () => {
    fresh();
    writeMirror(bed.path, HEADER + entry("e1"));
    const size = (HEADER + entry("e1")).length;
    appendFileSync(indexFile(), `${size + 200} zz1\n${size + 400} zz2\n`);
    const mirror = open();
    expect(mirror.facts()).toEqual({ size, lastEntryId: "e1" });
    expect(readFileSync(indexFile(), "utf8")).toBe(`${HEADER.length} hdr00001\n${size} e1\n`);
    // The ignored ids are no entries: one may be used, and the next index record follows the cut index.
    expect(mirror.onSessionAppend(appendOf(size, entry("zz1")))).toBe("ok");
    mirror.close();
    expect(open().facts().lastEntryId).toBe("zz1");
  });

  it("a record cut by a crash is dropped", () => {
    fresh();
    writeMirror(bed.path, HEADER + entry("e1"));
    appendFileSync(indexFile(), "99999 half");
    expect(open().facts().lastEntryId).toBe("e1");
  });

  it("a partial last line is cut from the file, found by reading back from the end", () => {
    fresh();
    const whole = HEADER + entry("e1");
    writeMirror(bed.path, `${whole}{"type":"message","id":"e2","par`);
    const { reads, read } = counting();
    expect(open({ read }).facts()).toEqual({ size: whole.length, lastEntryId: "e1" });
    expect(fileText()).toBe(whole);
    expect(reads.bytes).toBeLessThan(16 * 1024);
  });
});

// Mutant M-INDEX-NOT-INCREASING: accept ends that do not increase. Mutant M-NO-RECOVER: open a mirror whose index is wrong.
describe.each([
  ["malformed", () => writeFileSync(indexFile(), `${HEADER.length} hdr00001\nnot a record\n`)],
  ["not increasing", () => writeFileSync(indexFile(), `${HEADER.length} hdr00001\n${HEADER.length} e1\n`)],
  [
    "with two records ending at the same byte",
    () =>
      writeFileSync(
        indexFile(),
        `${HEADER.length} hdr00001\n${HEADER.length + entry("e1").length} e1\n${HEADER.length + entry("e1").length} e1b\n`,
      ),
  ],
  ["ending short of the file", () => writeFileSync(indexFile(), `${HEADER.length} hdr00001\n`)],
  ["missing", () => writeFileSync(indexFile(), "")],
  [
    "with an id twice",
    () =>
      writeFileSync(
        indexFile(),
        `${HEADER.length} hdr00001\n${HEADER.length + entry("e1").length} hdr00001\n`,
      ),
  ],
])("an index that is %s (AVM-E29: fail closed)", (_name, damage) => {
  it("keeps the mirror aside with the notice and starts empty, so the worker resends", () => {
    fresh();
    writeMirror(bed.path, HEADER + entry("e1"));
    damage();
    const mirror = open();
    expect(mirror.facts()).toEqual({ size: 0, lastEntryId: null });
    expect(keptFiles()).toHaveLength(1);
    expect(announced).toEqual(["replaced"]);
    expect(readFileSync(join(bed.folder, "replaced", keptFiles()[0] as string), "utf8")).toBe(
      HEADER + entry("e1"),
    );
    expect(mirror.onSessionAppend(appendOf(0, HEADER + entry("e1"), { replace: true }))).toBe("ok");
  });
});

describe("the index follows the file (AVM-E29)", () => {
  it("moves with the kept copy and starts over for the new file", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER + userEntry("u1", "x")));
    mirror.onSessionAppend(appendOf(0, HEADER + entry("x1"), { replace: true }));
    const [kept] = keptFiles().filter((name) => !name.endsWith(".unverified"));
    expect(readFileSync(join(bed.folder, "replaced", `${kept}.ids`), "utf8")).toContain(" u1\n");
    expect(readFileSync(indexFile(), "utf8")).toBe(
      `${HEADER.length} hdr00001\n${HEADER.length + entry("x1").length} x1\n`,
    );
  });

  it("is deleted with the kept copy when the replacement is an extension", () => {
    fresh();
    const mirror = open();
    const text = HEADER + entry("e1");
    mirror.onSessionAppend(appendOf(0, text));
    mirror.onSessionAppend(appendOf(0, text + entry("e2"), { replace: true }));
    expect(existsSync(join(bed.folder, "replaced"))).toBe(true);
    expect(keptFiles()).toEqual([]);
    expect(open().facts().lastEntryId).toBe("e2");
    expect(existsSync(indexFile())).toBe(true);
  });

  it("is removed with the mirror (RT-45)", () => {
    fresh();
    const mirror = open();
    mirror.onSessionAppend(appendOf(0, HEADER));
    mirror.close();
    removeMirrorFiles(bed.path);
    expect(existsSync(indexFile())).toBe(false);
  });
});
