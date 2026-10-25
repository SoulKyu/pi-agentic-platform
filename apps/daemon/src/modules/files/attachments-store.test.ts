import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDenySet } from "../../kernel/fs/deny-set.ts";
import { createAttachmentsStore, type AttachmentsStore } from "./attachments-store.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

const HOUR = 3_600_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
let bed: FilesBed;
let dir: string;
let store: AttachmentsStore;

const storeOf = (limits?: { count: number; bytes: number }): AttachmentsStore =>
  createAttachmentsStore({
    dir,
    clock: bed.clock,
    logger: bed.logger,
    deny: createDenySet(bed.bb.denySources([dir]), bed.clock),
    limits,
  });
const up = async (owner: string, sessionId: string, name: string, data: Buffer = Buffer.from("hello")) =>
  store.put(owner, store.reserve(owner, data.length), { sessionId, name, chunks: [data] });
const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );
const pendingOf = (): string[] => readdirSync(join(dir, "pending"));

beforeEach(() => {
  bed = createFilesBed();
  dir = join(bed.bb.papHome, "attachments");
  store = storeOf();
});
afterEach(() => {
  store.stop();
  bed.dispose();
});

describe("the pending store (M8R36, M8R37)", () => {
  it("stores an upload 0600 in pending/ and answers a view with a 22 character id", async () => {
    const view = await up("u1", "s1", "notes.txt");
    expect(view).toEqual({ id: view.id, name: "notes.txt", size: 5, kind: "file", mimeType: null });
    expect(view.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const path = join(dir, "pending", view.id);
    expect(readFileSync(path, "utf8")).toBe("hello");
    expect(statSync(path).mode & 0o7777).toBe(0o600);
    expect(statSync(dir).mode & 0o7777).toBe(0o700);
    expect(pendingOf()).toEqual([view.id]);
  });

  it("names an image from its bytes, whatever the file is called", async () => {
    const view = await up("u1", "s1", "photo.txt", PNG);
    expect(view).toMatchObject({ kind: "image", mimeType: "image/png", size: 12 });
  });

  it("refuses the 33rd pending upload of one owner and keeps the first 32", async () => {
    for (let i = 0; i < 32; i++) await up("u1", "s1", `f${i}.txt`, Buffer.from("x"));
    expect(await codeOf(up("u1", "s1", "one-more.txt", Buffer.from("x")))).toBe("limit_reached");
    expect(pendingOf()).toHaveLength(32);
    expect(await codeOf(up("u2", "s1", "other.txt", Buffer.from("x")))).toBeUndefined();
  });

  it("refuses one byte beyond the byte cap, counting a reservation still arriving", async () => {
    store.stop();
    store = storeOf({ count: 32, bytes: 10 });
    const arriving = store.reserve("u1", 6);
    await up("u1", "s1", "a.txt", Buffer.from("1234"));
    expect(() => store.reserve("u1", 1)).toThrow(PapError);
    arriving.cancel();
    expect(() => store.reserve("u1", 6)).not.toThrow();
  });

  it("frees the reservation of a body that fails, and leaves no file", async () => {
    store.stop();
    store = storeOf({ count: 1, bytes: 100 });
    const broken = (async function* () {
      yield Buffer.from("ab");
      throw new Error("aborted");
    })();
    await expect(
      store.put("u1", store.reserve("u1", 10), { sessionId: "s1", name: "a", chunks: broken }),
    ).rejects.toThrow("aborted");
    expect(pendingOf()).toEqual([]);
    expect(await codeOf(up("u1", "s1", "b.txt"))).toBeUndefined();
  });

  it("refuses a body shorter than declared, with no file left", async () => {
    const reservation = store.reserve("u1", 10);
    expect(
      await codeOf(
        store.put("u1", reservation, { sessionId: "s1", name: "a", chunks: [Buffer.from("abc")] }),
      ),
    ).toBe("bad_request");
    expect(pendingOf()).toEqual([]);
  });

  it("deletes an upload and its entry an hour later, at the next sweep, and frees its share", async () => {
    store.stop();
    store = storeOf({ count: 1, bytes: 100 });
    const view = await up("u1", "s1", "a.txt");
    await bed.clock.advance(HOUR - 1);
    expect(pendingOf()).toEqual([view.id]);
    await bed.clock.advance(5 * 60_000);
    await vi.waitFor(() => expect(pendingOf()).toEqual([]), { timeout: 5_000 });
    expect(await codeOf(store.claim("u1", "s1", [view.id]))).toBe("not_found");
    expect(await codeOf(up("u1", "s1", "b.txt"))).toBeUndefined();
  });

  it("does not claim an upload past its hour even before the sweep removes it", async () => {
    await bed.clock.advance(59 * 60_000 + 1_000);
    const view = await up("u1", "s1", "a.txt");
    const late = await up("u1", "s1", "b.txt");
    await bed.clock.advance(HOUR - 2_000);
    expect(pendingOf()).toEqual([view.id, late.id].sort());
    expect(await codeOf(store.claim("u1", "s1", [view.id]))).toBeUndefined();
    await bed.clock.advance(2_000);
    expect(await codeOf(store.claim("u1", "s1", [late.id]))).toBe("not_found");
  });

  it("empties pending/ at boot and never rebuilds the index from disk", async () => {
    const view = await up("u1", "s1", "a.txt");
    store.stop();
    store = storeOf();
    expect(pendingOf()).toEqual([]);
    expect(await codeOf(store.claim("u1", "s1", [view.id]))).toBe("not_found");
  });

  it("logs the folder's size at boot", async () => {
    await up("u1", "s1", "a.txt");
    const claimed = await store.claim("u1", "s1", [(await up("u1", "s1", "b.txt")).id]);
    expect(claimed.files).toHaveLength(1);
    store.stop();
    store = storeOf();
    const sizes = bed.lines.filter((line) => line.msg === "attachments_size");
    expect(sizes.at(-1)).toMatchObject({ bytes: 5, entries: 4, truncated: false });
  });
});

describe("claims (M8R39)", () => {
  it("answers not_found to another owner, another session and an id nobody uploaded", async () => {
    const view = await up("u1", "s1", "a.txt");
    expect(await codeOf(store.claim("u2", "s1", [view.id]))).toBe("not_found");
    expect(await codeOf(store.claim("u1", "s2", [view.id]))).toBe("not_found");
    expect(await codeOf(store.claim("u1", "s1", ["A".repeat(22)]))).toBe("not_found");
    expect(await codeOf(store.claim("u1", "s1", ["../../x"]))).toBe("not_found");
    expect(existsSync(join(dir, "s2"))).toBe(false);
  });

  it("answers bad_request to a duplicate id, before anything is copied", async () => {
    const view = await up("u1", "s1", "a.txt");
    expect(await codeOf(store.claim("u1", "s1", [view.id, view.id]))).toBe("bad_request");
    expect(existsSync(join(dir, "s1"))).toBe(false);
  });

  it("claims nothing when one id of the batch is refused", async () => {
    const view = await up("u1", "s1", "a.txt");
    expect(await codeOf(store.claim("u1", "s1", [view.id, "A".repeat(22)]))).toBe("not_found");
    expect(existsSync(join(dir, "s1"))).toBe(false);
  });

  it("copies a file to <session>/<id>/<name>, leaves the pending copy, and reuses the copy the second time", async () => {
    const view = await up("u1", "s1", "report final.pdf");
    const first = await store.claim("u1", "s1", [view.id]);
    const place = join(dir, "s1", view.id, "report final.pdf");
    expect(first).toEqual({
      images: [],
      files: [{ id: view.id, path: place, name: "report final.pdf", size: 5 }],
    });
    expect(readFileSync(place, "utf8")).toBe("hello");
    expect(statSync(place).mode & 0o7777).toBe(0o600);
    expect(statSync(join(dir, "s1")).mode & 0o7777).toBe(0o700);
    expect(pendingOf()).toEqual([view.id]);
    writeFileSync(place, "HELLO");
    const second = await store.claim("u1", "s1", [view.id]);
    expect(second.files).toEqual(first.files);
    expect(readFileSync(place, "utf8")).toBe("HELLO");
  });

  it("hands back an image as its pending file, with its type", async () => {
    const view = await up("u1", "s1", "p.png", PNG);
    const claimed = await store.claim("u1", "s1", [view.id]);
    expect(claimed).toEqual({
      images: [{ id: view.id, path: join(dir, "pending", view.id), mimeType: "image/png" }],
      files: [],
    });
    expect(existsSync(join(dir, "s1"))).toBe(false);
  });

  it("releases the images and the copied files of the owner, and frees their share (MC38 m3)", async () => {
    store.stop();
    store = storeOf({ count: 2, bytes: 100 });
    const image = await up("u1", "s1", "p.png", PNG);
    const file = await up("u1", "s1", "a.txt");
    await store.claim("u1", "s1", [image.id, file.id]);
    store.release("u2", [image.id, file.id]);
    expect(pendingOf()).toHaveLength(2);
    store.release("u1", [image.id, file.id, "A".repeat(22)]);
    await vi.waitFor(() => expect(pendingOf()).toEqual([]), { timeout: 5_000 });
    // The copy a prompt cites stays.
    expect(readFileSync(join(dir, "s1", file.id, "a.txt"), "utf8")).toBe("hello");
    expect(await codeOf(store.claim("u1", "s1", [image.id]))).toBe("not_found");
    expect(await codeOf(up("u1", "s1", "b.txt"))).toBeUndefined();
    expect(await codeOf(up("u1", "s1", "c.txt"))).toBeUndefined();
  });

  it("a claim keeps the pending file alive for another hour (MC38 m2)", async () => {
    const view = await up("u1", "s1", "p.png", PNG);
    await bed.clock.advance(HOUR - 1_000);
    await store.claim("u1", "s1", [view.id]);
    await bed.clock.advance(5 * 60_000);
    expect(pendingOf()).toEqual([view.id]);
    await bed.clock.advance(HOUR);
    await vi.waitFor(() => expect(pendingOf()).toEqual([]), { timeout: 5_000 });
  });

  it("refuses to claim a pending file that became a hard link to a private inode", async () => {
    mkdirSync(bed.bb.papHome, { recursive: true });
    const view = await up("u1", "s1", "a.txt");
    unlinkSync(join(dir, "pending", view.id));
    linkSync(join(bed.bb.papHome, "state.db"), join(dir, "pending", view.id));
    expect(await codeOf(store.claim("u1", "s1", [view.id]))).toBe("not_found");
    expect(existsSync(join(dir, "s1", view.id))).toBe(false);
  });
});

describe("dropOwner (a member's delete, A5b)", () => {
  it("forgets the owner's pending uploads and removes the copies made for the listed sessions only", async () => {
    const mine = await up("m1", "s1", "a.txt");
    const theirs = await up("u1", "s2", "b.txt");
    await store.claim("m1", "s1", [mine.id]);
    await store.claim("u1", "s2", [theirs.id]);
    expect(existsSync(join(dir, "s1"))).toBe(true);
    const other = await up("m1", "s3", "c.txt");
    store.dropOwner("m1", ["s1", "pending", "../escape"]);
    expect(existsSync(join(dir, "s1"))).toBe(false);
    expect(existsSync(join(dir, "s2"))).toBe(true);
    expect(existsSync(join(dir, "pending"))).toBe(true);
    expect(await codeOf(store.claim("m1", "s3", [other.id]))).toBe("not_found");
    expect(await codeOf(store.claim("u1", "s2", [theirs.id]))).toBeUndefined();
  });
});
