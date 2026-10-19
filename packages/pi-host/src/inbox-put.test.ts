import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_LIMITS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInbox, type FilePut } from "./inbox-put.ts";

/*
 * Mutants (RT-43), each run for real and killed by the named case:
 *  M1 the part is opened without O_EXCL (a hard link planted at the part name is written through) -> "never writes through a hard link planted at the part name"
 *  M2 the final name is taken with a replacing rename (no `exists`, a link at `name` replaced)    -> "answers exists and removes the part when the name is taken", "never follows a link planted at the final name"
 *  M3 the offset check is dropped                                                                 -> "answers order for a chunk out of order and removes the part"
 *  M4 the size limit is off by one (`>=`)                                                         -> "answers too_large on the byte past the limit and removes the part"
 *  (a symlink at the part name is refused by openAt's O_NOFOLLOW, covered in nofollow.test.ts and "never writes through a link planted at the part name")
 */

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
let dir: string;
let inbox: string;
let outside: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-inbox-"));
  inbox = join(dir, "inbox");
  outside = join(dir, "outside");
  mkdirSync(inbox);
  mkdirSync(outside);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const chunk = (bytes: Buffer, over: Partial<FilePut> = {}): FilePut => ({
  type: "file_put",
  id: ID,
  name: "photo.png",
  offset: 0,
  data: bytes.toString("base64"),
  last: false,
  ...over,
});

describe("createInbox (R33, RT-15)", () => {
  it("lands a 5 MiB file sent in three chunks whole under its name, directly in the inbox", () => {
    const whole = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < whole.length; i++) whole[i] = i % 251;
    const cuts = [0, 2 * 1024 * 1024, 4 * 1024 * 1024, whole.length];
    const box = createInbox(inbox);
    const answers = [0, 1, 2].map((n) => {
      const part = whole.subarray(cuts[n], cuts[n + 1]);
      return box.put(chunk(part, { offset: cuts[n] ?? 0, last: n === 2 }));
    });
    expect(answers).toEqual([null, null, { type: "file_put_result", id: ID, ok: true }]);
    expect(readdirSync(inbox)).toEqual(["photo.png"]);
    expect(readFileSync(join(inbox, "photo.png")).equals(whole)).toBe(true);
    expect(statSync(join(inbox, "photo.png")).mode & 0o777).toBe(0o644);
  });

  it("lands an empty file sent as one last chunk", () => {
    expect(createInbox(inbox).put(chunk(Buffer.alloc(0), { last: true }))?.ok).toBe(true);
    expect(readFileSync(join(inbox, "photo.png")).length).toBe(0);
  });

  it("answers order for a chunk out of order and removes the part", () => {
    const box = createInbox(inbox);
    expect(box.put(chunk(Buffer.from("abcd")))).toBeNull();
    expect(box.put(chunk(Buffer.from("ef"), { offset: 9 }))).toEqual({
      type: "file_put_result",
      id: ID,
      ok: false,
      code: "order",
    });
    expect(readdirSync(inbox)).toEqual([]);
    // the transfer is over: a further chunk of the same id has no part to continue
    expect(box.put(chunk(Buffer.from("ef"), { offset: 4, last: true }))?.code).toBe("order");
  });

  it("answers order for a first chunk that does not start at 0", () => {
    expect(createInbox(inbox).put(chunk(Buffer.from("ab"), { offset: 2 }))?.code).toBe("order");
    expect(readdirSync(inbox)).toEqual([]);
  });

  it("answers too_large on the byte past the limit and removes the part", () => {
    const box = createInbox(inbox);
    const half = Buffer.alloc(FILE_LIMITS.uploadBytes - 1);
    expect(box.put(chunk(half))).toBeNull();
    // exactly the limit is accepted
    expect(box.put(chunk(Buffer.alloc(1), { offset: half.length, last: true }))?.ok).toBe(true);
    const again = createInbox(inbox);
    expect(again.put(chunk(half, { id: OTHER, name: "b.png" }))).toBeNull();
    expect(
      again.put(chunk(Buffer.alloc(2), { id: OTHER, name: "b.png", offset: half.length, last: true })),
    ).toEqual({
      type: "file_put_result",
      id: OTHER,
      ok: false,
      code: "too_large",
    });
    expect(readdirSync(inbox)).toEqual(["photo.png"]);
  });

  it("answers exists and removes the part when the name is taken", () => {
    writeFileSync(join(inbox, "photo.png"), "mine");
    const answer = createInbox(inbox).put(chunk(Buffer.from("new"), { last: true }));
    expect(answer).toEqual({ type: "file_put_result", id: ID, ok: false, code: "exists" });
    expect(readFileSync(join(inbox, "photo.png"), "utf8")).toBe("mine");
    expect(readdirSync(inbox)).toEqual(["photo.png"]);
  });

  it("never writes through a link planted at the part name", () => {
    const target = join(outside, "victim");
    writeFileSync(target, "keep");
    symlinkSync(target, join(inbox, `.${ID}.part`));
    const answer = createInbox(inbox).put(chunk(Buffer.from("evil"), { last: true }));
    expect(answer).toMatchObject({ ok: false, code: "write_failed" });
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("never writes through a hard link planted at the part name", () => {
    const target = join(outside, "victim");
    writeFileSync(target, "keep");
    linkSync(target, join(inbox, `.${ID}.part`));
    expect(createInbox(inbox).put(chunk(Buffer.from("evil")))).toMatchObject({ code: "write_failed" });
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("never follows a link planted at the final name", () => {
    const target = join(outside, "victim");
    symlinkSync(target, join(inbox, "photo.png"));
    const answer = createInbox(inbox).put(chunk(Buffer.from("evil"), { last: true }));
    expect(answer).toMatchObject({ ok: false, code: "exists" });
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(inbox)).toEqual(["photo.png"]);
  });

  it("answers write_failed when the inbox is gone", () => {
    rmSync(inbox, { recursive: true });
    expect(createInbox(inbox).put(chunk(Buffer.from("a"), { last: true }))).toMatchObject({
      ok: false,
      code: "write_failed",
    });
  });

  it("keeps two transfers apart", () => {
    const box = createInbox(inbox);
    box.put(chunk(Buffer.from("aa"), { name: "a.png" }));
    box.put(chunk(Buffer.from("bb"), { id: OTHER, name: "b.png", last: true }));
    box.put(chunk(Buffer.from("AA"), { name: "a.png", offset: 2, last: true }));
    expect(readFileSync(join(inbox, "a.png"), "utf8")).toBe("aaAA");
    expect(readFileSync(join(inbox, "b.png"), "utf8")).toBe("bb");
  });
});
