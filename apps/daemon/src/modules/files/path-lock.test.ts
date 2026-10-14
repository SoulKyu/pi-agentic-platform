import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createPathLock } from "./path-lock.ts";
import { createFilesService } from "./service.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

describe("createPathLock", () => {
  it("runs the work of one path in order, lets other paths pass and forgets settled paths", async () => {
    const lock = createPathLock();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = lock.run("/a", async () => {
      await gate;
      order.push("a1");
    });
    const second = lock.run("/a", async () => void order.push("a2"));
    await lock.run("/b", async () => void order.push("b"));
    expect(order).toEqual(["b"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["b", "a1", "a2"]);
    await Promise.resolve();
    expect(lock.size).toBe(0);
  });

  it("keeps going after a failure and still forgets the path", async () => {
    const lock = createPathLock();
    await expect(lock.run("/a", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(lock.run("/a", async () => 1)).resolves.toBe(1);
    await Promise.resolve();
    expect(lock.size).toBe(0);
  });
});

describe("two writers of one file (MC38 m1)", () => {
  let bed: FilesBed;
  beforeEach(() => {
    bed = createFilesBed();
  });
  afterEach(() => bed.dispose());
  const etagOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);
  const files = () =>
    createFilesService({
      roots: () => [bed.repo],
      boundary: bed.bb.config(),
      deny: bed.deny,
      git: bed.git,
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      workerUmask: 0o022,
    });
  const owner = testCaller();

  it("a second save on the same base etag answers conflict and the file holds the first", async () => {
    const path = join(bed.repo, "shared.txt");
    writeFileSync(path, "base\n");
    const service = files();
    const baseEtag = etagOf("base\n");
    const [one, two] = await Promise.all([
      service.write(owner, { path, text: "one\n", baseEtag }).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      ),
      service.write(owner, { path, text: "two\n", baseEtag }).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      ),
    ]);
    // Either save may take the lock first: exactly one wins and the file holds the winner's text.
    expect([one, two].toSorted()).toEqual(["conflict", "ok"]);
    expect(readFileSync(path, "utf8")).toBe(one === "ok" ? "one\n" : "two\n");
  });

  it("a save waits for an upload of the same file and then sees it as a conflict", async () => {
    const path = join(bed.repo, "shared.txt");
    writeFileSync(path, "base\n");
    const service = files();
    // The upload holds the lock once its body is being read: the save starts only then, so the order is fixed.
    let pulled!: () => void;
    const holding = new Promise<void>((resolve) => (pulled = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const upload = service.upload(owner, {
      path,
      conflict: "replace",
      confirmProtected: false,
      chunks: (async function* () {
        pulled();
        await gate;
        yield Buffer.from("uploaded\n");
      })(),
    });
    await holding;
    const save = service.write(owner, { path, text: "mine\n", baseEtag: etagOf("base\n") }).then(
      () => "ok",
      (e: { code?: string }) => e.code,
    );
    release();
    await upload;
    expect(await save).toBe("conflict");
    expect(readFileSync(path, "utf8")).toBe("uploaded\n");
  });
});
