import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileEntry, FilesListResult, FilesReadResult } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OpsBed, opsBed } from "./testing.ts";

let bed: OpsBed;
beforeEach(() => {
  bed = opsBed();
});
afterEach(() => bed.clean());

const read = (path: string, offset = 0) => ({ name: "fs.read", path, offset }) as const;
const write = (path: string, text: string, baseEtag: string | null) =>
  ({ name: "fs.write", path, text, baseEtag }) as const;
const b64 = (text: string) => Buffer.from(text).toString("base64");
let uploads = 0;
const put = (
  path: string,
  id: string,
  offset: number,
  text: string,
  last: boolean,
  conflict: "skip" | "replace",
) => ({ name: "fs.put", id, path, offset, data: b64(text), last, conflict }) as const;
const fresh = (): string => (++uploads).toString(16).padStart(32, "0");

describe("fs paths", () => {
  it("refuses a link and a path outside the project", async () => {
    writeFileSync(join(bed.outside, "secret.txt"), "secret");
    mkdirSync(join(bed.project, "real"));
    writeFileSync(join(bed.project, "real", "a.txt"), "a");
    symlinkSync(bed.outside, join(bed.project, "dir-link"));
    symlinkSync(join(bed.project, "real", "a.txt"), join(bed.project, "file-link"));
    symlinkSync("missing", join(bed.project, "dangling"));

    for (const path of [
      `${bed.project}/dir-link/secret.txt`,
      `${bed.project}/file-link`,
      `${bed.project}/dangling`,
      `${bed.project}/real/../../outside/secret.txt`,
      `${bed.project}/real/./a.txt`,
      `${bed.project}//real/a.txt`,
      `${bed.project}/real//a.txt`,
      `${bed.project}x/a.txt`,
      `${bed.outside}/secret.txt`,
      "/etc/passwd",
    ])
      expect(await bed.refusal(read(path)), path).toBe("not_found");
    expect(await bed.refusal({ name: "fs.list", path: `${bed.project}/dir-link`, showIgnored: true })).toBe(
      "not_found",
    );
    expect(await bed.refusal({ name: "fs.get", path: `${bed.project}/dir-link/secret.txt`, offset: 0 })).toBe(
      "not_found",
    );
    // A write through a link lands nowhere.
    expect(await bed.refusal(write(`${bed.project}/dir-link/new.txt`, "x", null))).toBe("not_found");
    expect(existsSync(join(bed.outside, "new.txt"))).toBe(false);
    expect(await bed.refusal(write(`${bed.project}/file-link`, "x", null))).toBe("not_found");
    expect(readFileSync(join(bed.project, "real", "a.txt"), "utf8")).toBe("a");
    expect(await bed.value(read(`${bed.project}/real/a.txt`))).toMatchObject({ text: "a" });
  });

  it("lists with the host's shape: folders first, links described, .git hidden at every level", async () => {
    mkdirSync(join(bed.project, ".git"));
    mkdirSync(join(bed.project, "src"));
    writeFileSync(join(bed.project, "b.txt"), "bb");
    symlinkSync(bed.outside, join(bed.project, "out-link"));
    symlinkSync("missing", join(bed.project, "broken"));
    const listed = FilesListResult.parse(
      await bed.value({ name: "fs.list", path: bed.project, showIgnored: false }),
    );
    expect(
      listed.entries.map((entry: FileEntry) => [entry.name, entry.kind, entry.link, entry.protected]),
    ).toEqual([
      ["out-link", "link", "outside", false], // a link to a folder sorts with the folders
      ["src", "dir", null, false],
      ["b.txt", "file", null, false],
      ["broken", "link", "broken", false],
    ]);
    const inside = FilesListResult.parse(
      await bed.value({ name: "fs.list", path: `${bed.project}/.git`, showIgnored: false }),
    );
    expect(inside.entries).toEqual([]);
    mkdirSync(join(bed.project, "src", ".git"));
    writeFileSync(join(bed.project, "src", ".git", "x"), "x");
    const nested = FilesListResult.parse(
      await bed.value({ name: "fs.list", path: `${bed.project}/src`, showIgnored: true }),
    );
    expect(nested.entries).toEqual([]);
    // Like the host, a path inside .git can still be read.
    expect(await bed.value(read(`${bed.project}/src/.git/x`))).toMatchObject({ text: "x" });
  });

  it("reads a chunk with its meta and an etag that fs.write accepts", async () => {
    writeFileSync(join(bed.project, "a.txt"), "héllo\n");
    const answer = FilesReadResult.parse(await bed.value(read(`${bed.project}/a.txt`)));
    expect(answer).toMatchObject({ text: "héllo\n", offset: 0, nextOffset: null });
    expect(answer.meta).toMatchObject({
      path: `${bed.project}/a.txt`,
      size: 7,
      binary: false,
      editable: true,
    });
    const bytes = await bed.value({ name: "fs.get", path: `${bed.project}/a.txt`, offset: 0 });
    expect(bytes).toEqual({ data: b64("héllo\n"), size: 7, nextOffset: null });
  });
});

describe("fs.write", () => {
  it("writes atomically and refuses a stale etag", async () => {
    const path = `${bed.project}/notes/a.txt`;
    mkdirSync(join(bed.project, "notes"));
    const created = (await bed.value(write(path, "one", null))) as { etag: string };
    const meta = FilesReadResult.parse(await bed.value(read(path))).meta;
    expect(meta.etag).toBe(created.etag);
    // A creation over an existing file, and a change with no etag, are conflicts.
    expect(await bed.refusal(write(path, "two", null))).toBe("conflict");
    expect(await bed.refusal(write(path, "two", "0".repeat(32)))).toBe("conflict");
    expect(await bed.refusal(write(`${bed.project}/notes/new.txt`, "x", created.etag))).toBe("conflict");
    expect(readFileSync(join(bed.project, "notes", "a.txt"), "utf8")).toBe("one");
    const changed = (await bed.value(write(path, "two", created.etag))) as { etag: string };
    expect(changed.etag).not.toBe(created.etag);
    // The old etag is stale now.
    expect(await bed.refusal(write(path, "three", created.etag))).toBe("conflict");
    expect(readFileSync(join(bed.project, "notes", "a.txt"), "utf8")).toBe("two");
    // No temporary file stays behind.
    expect(readdirSync(join(bed.project, "notes"))).toEqual(["a.txt"]);
  });

  it("never writes a .git entry or inside one, at the root or in a subfolder", async () => {
    mkdirSync(join(bed.project, "sub"));
    for (const path of [`${bed.project}/.git`, `${bed.project}/sub/.git`, `${bed.project}/sub/.GIT/x`]) {
      expect(await bed.refusal(write(path, "gitdir: /elsewhere\n", null)), path).toBe("bad_request");
      expect(await bed.refusal(put(path, fresh(), 0, "gitdir: /elsewhere\n", true, "replace")), path).toBe(
        "bad_request",
      );
    }
    expect(readdirSync(join(bed.project, "sub"))).toEqual([]);
    mkdirSync(join(bed.project, ".git"));
    expect(await bed.refusal(write(`${bed.project}/.git/config`, "x", null))).toBe("bad_request");
    expect(await bed.refusal(put(`${bed.project}/.git/hooks`, fresh(), 0, "x", true, "replace"))).toBe(
      "bad_request",
    );
    expect(readdirSync(join(bed.project, ".git"))).toEqual([]);
  });
});

describe("fs.put", () => {
  it("puts chunks in order and honours conflict skip", async () => {
    const path = `${bed.project}/up.bin`;
    const id = fresh();
    expect(await bed.value(put(path, id, 0, "abc", false, "skip"))).toEqual({ done: false, skipped: false });
    // The next chunk must start where the last one ended.
    expect(await bed.refusal(put(path, id, 5, "x", false, "skip"))).toBe("bad_request");
    // The transfer was dropped with its temporary file: it starts over.
    expect(readdirSync(bed.project)).toEqual([]);
    expect(await bed.value(put(path, id, 0, "abc", false, "skip"))).toEqual({ done: false, skipped: false });
    expect(await bed.value(put(path, id, 3, "def", true, "skip"))).toEqual({ done: true, skipped: false });
    expect(readFileSync(path, "utf8")).toBe("abcdef");
    expect(readdirSync(bed.project)).toEqual(["up.bin"]);

    // skip leaves an existing file alone and says so at the first chunk
    expect(await bed.value(put(path, fresh(), 0, "zzz", true, "skip"))).toEqual({
      done: true,
      skipped: true,
    });
    expect(readFileSync(path, "utf8")).toBe("abcdef");
    // replace puts the new bytes in its place
    const again = fresh();
    expect(await bed.value(put(path, again, 0, "ghi", false, "replace"))).toEqual({
      done: false,
      skipped: false,
    });
    expect(await bed.value(put(path, again, 3, "jkl", true, "replace"))).toEqual({
      done: true,
      skipped: false,
    });
    expect(readFileSync(path, "utf8")).toBe("ghijkl");
    expect(readdirSync(bed.project)).toEqual(["up.bin"]);
  });

  it("refuses a first chunk that does not start at 0 and a path through a link", async () => {
    expect(await bed.refusal(put(`${bed.project}/a`, fresh(), 3, "x", true, "skip"))).toBe("bad_request");
    symlinkSync(bed.outside, join(bed.project, "link"));
    expect(await bed.refusal(put(`${bed.project}/link/a`, fresh(), 0, "x", true, "replace"))).toBe(
      "not_found",
    );
    expect(readdirSync(bed.outside)).toEqual([]);
  });
});
