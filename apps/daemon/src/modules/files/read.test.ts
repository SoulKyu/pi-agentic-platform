import { createHash } from "node:crypto";
import { linkSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { readChunk } from "./read.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

let bed: FilesBed;
beforeEach(() => {
  bed = createFilesBed();
});
afterEach(() => bed.dispose());

const read = (path: string, offset?: number, over: { roots?: string[]; caller?: "session" | "token" } = {}) =>
  readChunk(bed.env(), bed.scope(over.roots ?? [bed.repo], over.caller ?? "session"), path, offset);
const code = async (run: Promise<unknown>) => ((await run.catch((e: unknown) => e)) as PapError).code;
const KIB = 1024;

describe("a small text file", () => {
  it("answers its text, its etag, its size and mtime, and that it is editable", async () => {
    const path = bed.file(join(bed.repo, "small.txt"), "héllo\n");
    const st = statSync(path);
    const answer = await read(path);
    expect(answer).toEqual({
      meta: {
        path,
        size: st.size,
        mtimeMs: st.mtimeMs,
        etag: createHash("sha256").update("héllo\n").digest("hex").slice(0, 32),
        binary: false,
        editable: true,
        protection: "none",
      },
      text: "héllo\n",
      offset: 0,
      nextOffset: null,
    });
  });

  it("clamps a pre-1970 mtime to 0 (m3)", async () => {
    const path = bed.file(join(bed.repo, "old.txt"), "a");
    utimesSync(path, new Date("1969-12-31"), new Date("1969-12-31"));
    expect((await read(path)).meta.mtimeMs).toBe(0);
  });

  it("keeps a byte order mark", async () => {
    const path = bed.file(join(bed.repo, "bom.txt"), "﻿hi");
    expect((await read(path)).text).toBe("﻿hi");
  });

  it("answers an empty text past the end", async () => {
    const path = bed.file(join(bed.repo, "small.txt"), "abc");
    const answer = await read(path, 99);
    expect([answer.text, answer.offset, answer.nextOffset]).toEqual(["", 99, null]);
    expect(answer.meta.size).toBe(3);
  });

  it("is not editable when it is not valid UTF-8: a save would write replacement characters", async () => {
    const path = join(bed.repo, "latin1.txt");
    writeFileSync(path, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const answer = await read(path);
    expect(answer.text).toBe("caf�");
    expect(answer.meta).toMatchObject({ binary: false, editable: false });
    expect(answer.meta.etag).toHaveLength(32);
  });
});

describe("binary files", () => {
  it("answers no text for a NUL in the first 8 KiB, whatever the offset", async () => {
    const path = join(bed.repo, "bin.dat");
    writeFileSync(path, Buffer.concat([Buffer.from("abc"), Buffer.from([0]), Buffer.from("def")]));
    for (const offset of [undefined, 0, 2]) {
      const answer = await read(path, offset);
      expect(answer.text, String(offset)).toBe("");
      expect(answer.nextOffset).toBeNull();
      expect(answer.meta).toMatchObject({ binary: true, editable: false, size: 7 });
    }
  });

  it("looks only at the first 8 KiB for the NUL", async () => {
    const path = join(bed.repo, "late.dat");
    writeFileSync(path, Buffer.concat([Buffer.alloc(8 * KIB, 0x61), Buffer.from([0])]));
    const answer = await read(path);
    expect(answer.meta.binary).toBe(false);
    expect(answer.text).toBe(`${"a".repeat(8 * KIB)}\0`);
  });
});

describe("chunks", () => {
  it("cuts a chunk at 256 KiB back to a character boundary and continues with that character", async () => {
    const head = "a".repeat(256 * KIB - 1);
    const path = bed.file(join(bed.repo, "euro.txt"), `${head}€tail`);
    const first = await read(path);
    expect(first.text).toBe(head);
    expect(first.nextOffset).toBe(256 * KIB - 1);
    expect(first.meta.editable).toBe(true);
    expect(first.meta.etag).toHaveLength(32);
    const second = await read(path, first.nextOffset ?? 0);
    expect(second.text).toBe("€tail");
    expect(second.offset).toBe(256 * KIB - 1);
    expect(second.nextOffset).toBeNull();
    expect(first.text + second.text).not.toContain("�");
  });

  it("starts at the next character when the offset falls inside one", async () => {
    const path = bed.file(join(bed.repo, "euro.txt"), "a€b");
    const answer = await read(path, 2);
    expect([answer.text, answer.offset]).toEqual(["b", 4]);
  });

  it("gives a file over 384 KiB no etag and no editor, and a first chunk of 256 KiB", async () => {
    const path = bed.file(join(bed.repo, "big.txt"), "x".repeat(400 * KIB));
    const answer = await read(path);
    expect(answer.meta).toMatchObject({ etag: null, editable: false, size: 400 * KIB });
    expect(answer.text).toHaveLength(256 * KIB);
    expect(answer.nextOffset).toBe(256 * KIB);
  });

  it("keeps a file of exactly 384 KiB editable and etagged", async () => {
    const path = bed.file(join(bed.repo, "edge.txt"), "x".repeat(384 * KIB));
    const answer = await read(path);
    expect(answer.meta).toMatchObject({ editable: true, size: 384 * KIB });
    expect(answer.meta.etag).toHaveLength(32);
    const over = bed.file(join(bed.repo, "over.txt"), "x".repeat(384 * KIB + 1));
    expect((await read(over)).meta).toMatchObject({ editable: false, etag: null });
  });

  it("halves a chunk whose JSON would not fit a page, and says the file is not editable (M8R26)", async () => {
    const path = bed.file(join(bed.repo, "ctl.txt"), "\u0001".repeat(300 * KIB));
    const answer = await read(path);
    expect(answer.meta.editable).toBe(false);
    expect(answer.text).toHaveLength(128 * KIB);
    expect(answer.nextOffset).toBe(128 * KIB);
    expect(sizeOf(answer)).toBeLessThanOrEqual(PAGE_BYTES);
  });

  it("keeps a file editable when its whole text fits one frame", async () => {
    const path = bed.file(join(bed.repo, "tabs.txt"), "\t".repeat(100 * KIB));
    expect((await read(path)).meta.editable).toBe(true);
  });
});

describe("what the boundary refuses answers not_found", () => {
  it("a missing file, a folder, a path outside the roots and a relative path", async () => {
    for (const path of [
      join(bed.repo, "missing"),
      bed.repo,
      bed.bb.outside,
      join(bed.bb.outside, "secret.txt"),
      "a.txt",
    ])
      expect(await code(read(path)), path).toBe("not_found");
  });

  it("a FIFO, without waiting for a writer", async () => {
    const path = join(bed.repo, "pipe");
    bed.fifo(path);
    expect(await code(read(path))).toBe("not_found");
  });

  it("a hard link to Pi's auth.json", async () => {
    const alias = join(bed.bb.proj, "alias.txt");
    linkSync(join(bed.bb.agentDir, "auth.json"), alias);
    expect(await code(read(alias, 0, { roots: [bed.bb.proj] }))).toBe("not_found");
    expect(await code(read(join(bed.bb.agentDir, "auth.json"), 0, { roots: [bed.bb.home] }))).toBe(
      "not_found",
    );
  });

  it("a token's read of .pi/mcp.json, and of .mcp.json", async () => {
    const roots = [bed.bb.proj];
    for (const path of [join(bed.bb.proj, ".pi", "mcp.json"), join(bed.bb.proj, ".mcp.json")]) {
      expect(await code(read(path, 0, { roots, caller: "token" })), path).toBe("not_found");
      expect((await read(path, 0, { roots })).text).toBe("x");
    }
  });
});

describe("protection", () => {
  it("is confirm for .envrc and step_up for .pi/settings.json, none otherwise", async () => {
    const roots = [bed.bb.proj];
    expect((await read(join(bed.bb.proj, ".envrc"), 0, { roots })).meta.protection).toBe("confirm");
    expect((await read(join(bed.bb.proj, ".pi", "settings.json"), 0, { roots })).meta.protection).toBe(
      "step_up",
    );
    expect((await read(join(bed.bb.proj, "a.txt"), 0, { roots })).meta.protection).toBe("none");
  });
});

describe("a file whose st_size is a lie (carry 10)", () => {
  it.skipIf(process.platform !== "linux")("reads what /proc holds although it reports 0 bytes", async () => {
    const path = "/proc/self/status";
    expect(statSync(path).size).toBe(0);
    const answer = await read(path, 0, { roots: ["/"] });
    expect(answer.text).toContain("Name:");
    expect(answer.meta.size).toBeGreaterThan(0);
    expect(answer.meta.etag).toHaveLength(32);
  });

  it.skipIf(process.platform !== "linux")("a token does not read /proc at all", async () => {
    expect(await code(read("/proc/self/status", 0, { roots: ["/"], caller: "token" }))).toBe("not_found");
  });
});
