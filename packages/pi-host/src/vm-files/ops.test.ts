import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeVmWorld } from "../testing/vm-world.ts";
import { realVmRoots } from "../policy/vm-paths.ts";
import { createVmFileOps, VM_READ_MAX_BYTES, VmFileRefused } from "./ops.ts";

// RT-01 mutants, each run for real and killed by the cases named here (RT-43):
//  - O1 no O_NOFOLLOW on the leaf (the flag dropped from the last component): "a file swapped for a link ... writeFile".
//  - O2 the whole path opened at once (one `openSync(absolute, flags | O_NOFOLLOW)` instead of component by component):
//    "a folder swapped for a link ... readFile" and "mkdir through a link" (the middle component is followed).
//  - O3 O_NONBLOCK dropped: "a FIFO is refused ... without blocking": the blocking open hangs the
//    thread, so the test's own timeout cannot fire; the run is killed by its outer timeout (a failure all the same).
//  - O4 `regular()` dropped: the same FIFO case and "a folder is not a file".
//  - O6 `regular()` leaking the descriptor (no close before the throw): "does not leak a descriptor on a refused open".
//  - O5 `split` accepting `..`: "a `..` spelling is refused".

let world: ReturnType<typeof makeVmWorld>;
let ops: ReturnType<typeof createVmFileOps>;
let home: string;
beforeEach(async () => {
  world = makeVmWorld();
  home = world.layout.home;
  ops = createVmFileOps(await realVmRoots(world.layout));
});
afterEach(() => world.cleanup());

const transcript = () => readFileSync(world.transcript, "utf8");

describe("createVmFileOps: links planted before or during a call", () => {
  it("refuses a write to a file swapped for a link to the transcript after the judge, transcript unchanged", async () => {
    const target = join(home, "plain.txt");
    writeFileSync(target, "plain");
    rmSync(target);
    symlinkSync(world.transcript, target);
    await expect(ops.write.writeFile(target, "OVERWRITTEN")).rejects.toThrow(VmFileRefused);
    await expect(ops.edit.writeFile(target, "OVERWRITTEN")).rejects.toThrow(VmFileRefused);
    expect(transcript()).toBe("TRANSCRIPT\n");
  });

  it("refuses a dangling link: nothing is created through it", async () => {
    const target = join(home, "x");
    symlinkSync(join(world.layout.sessions, "new.jsonl"), target);
    await expect(ops.write.writeFile(target, "data")).rejects.toThrow(VmFileRefused);
    expect(existsSync(join(world.layout.sessions, "new.jsonl"))).toBe(false);
  });

  it("refuses a read through a folder swapped for a link to .pi after the judge", async () => {
    mkdirSync(join(home, "d"));
    writeFileSync(join(home, "d", "x.txt"), "x");
    rmSync(join(home, "d"), { recursive: true });
    symlinkSync(world.layout.pi, join(home, "d"));
    await expect(ops.read.readFile(join(home, "d", "sessions", "s.jsonl"))).rejects.toThrow(VmFileRefused);
    await expect(ops.edit.readFile(join(home, "d", "sessions", "s.jsonl"))).rejects.toThrow(VmFileRefused);
    await expect(ops.read.access(join(home, "d", "sessions", "s.jsonl"))).rejects.toThrow(VmFileRefused);
  });

  it("`mkdir` through a link creates nothing in .pi, and `writeFile` through it writes nothing", async () => {
    symlinkSync(world.layout.pi, join(home, "dl"));
    await expect(ops.write.mkdir(join(home, "dl", "made"))).rejects.toThrow(VmFileRefused);
    await expect(ops.write.mkdir(join(home, "dl"))).rejects.toThrow(VmFileRefused);
    await expect(ops.write.writeFile(join(home, "dl", "sessions", "s.jsonl"), "X")).rejects.toThrow(
      VmFileRefused,
    );
    expect(existsSync(join(world.layout.pi, "made"))).toBe(false);
    expect(transcript()).toBe("TRANSCRIPT\n");
  });

  it("refuses a link as the last component of a read and of `ls`", async () => {
    symlinkSync(world.transcript, join(home, "t"));
    symlinkSync(world.layout.pi, join(home, "dl"));
    await expect(ops.read.readFile(join(home, "t"))).rejects.toThrow(VmFileRefused);
    expect(() => ops.ls.readdir(join(home, "dl"))).toThrow(VmFileRefused);
    // The entry itself, not what it points to: a link in a listing is a non-folder, never followed.
    expect(ops.ls.stat(join(home, "dl")).isDirectory()).toBe(false);
    expect(ops.ls.exists(join(home, "dl"))).toBe(false);
    expect(ops.ls.exists(join(home, "t"))).toBe(false);
  });
});

describe("createVmFileOps: what is refused", () => {
  it("refuses a FIFO for read and write without blocking", async () => {
    const fifo = join(home, "pipe");
    execFileSync("mkfifo", [fifo]);
    await expect(ops.read.readFile(fifo)).rejects.toThrow(VmFileRefused);
    await expect(ops.write.writeFile(fifo, "x")).rejects.toThrow(VmFileRefused);
    await expect(ops.read.detectImageMimeType(fifo)).rejects.toThrow(VmFileRefused);
    expect(ops.ls.exists(fifo)).toBe(true);
  }, 5000);

  it("refuses a folder as a file", async () => {
    await expect(ops.read.readFile(home)).rejects.toThrow(VmFileRefused);
    await expect(ops.write.writeFile(home, "x")).rejects.toThrow(VmFileRefused);
  });

  it("refuses a path outside every root, a `..` spelling, a relative path and a NUL", async () => {
    for (const bad of [
      world.transcript,
      "/proc/self/environ",
      join(home, "..", ".pi", "sessions", "s.jsonl"),
      `${home}/./z.txt`,
      `${home}//z.txt`,
      "z.txt",
      `${home}/a\0b`,
    ]) {
      await expect(ops.read.readFile(bad), bad).rejects.toThrow(VmFileRefused);
      await expect(ops.write.writeFile(bad, "x"), bad).rejects.toThrow(VmFileRefused);
    }
    expect(transcript()).toBe("TRANSCRIPT\n");
  });

  it("refuses a write under the read-only roots, and reads them", async () => {
    const skill = join(world.layout.piAgentDir, "skills", "k.md");
    await expect(ops.write.writeFile(skill, "x")).rejects.toThrow(VmFileRefused);
    await expect(ops.edit.writeFile(skill, "x")).rejects.toThrow(VmFileRefused);
    await expect(ops.edit.access(skill)).rejects.toThrow(VmFileRefused);
    await expect(ops.write.mkdir(join(world.layout.piAgentDir, "skills", "n"))).rejects.toThrow(
      VmFileRefused,
    );
    expect((await ops.read.readFile(skill)).toString()).toBe("skill\n");
    expect(readFileSync(skill, "utf8")).toBe("skill\n");
  });

  it("says what went wrong: size, missing and link have their own messages", async () => {
    const big = join(home, "big2.bin");
    writeFileSync(big, "");
    truncateSync(big, VM_READ_MAX_BYTES + 1);
    await expect(ops.read.readFile(big)).rejects.toThrow(
      `file over ${VM_READ_MAX_BYTES} bytes: read it with the shell (head, sed -n)`,
    );
    await expect(ops.read.readFile(join(home, "none.txt"))).rejects.toThrow("pap: no such file");
    await expect(ops.read.readFile(join(home, "none", "deeper.txt"))).rejects.toThrow("pap: no such file");
    symlinkSync(world.transcript, join(home, "t2"));
    await expect(ops.read.readFile(join(home, "t2"))).rejects.toThrow(
      "outside this agent's folders, or a link",
    );
    // A file where a folder is expected is a refusal (ENOTDIR), not a system error.
    writeFileSync(join(home, "plain.txt"), "p");
    await expect(ops.write.mkdir(join(home, "plain.txt", "sub"))).rejects.toThrow(VmFileRefused);
  });

  it("does not leak a descriptor on a refused open (a FIFO, a folder, a link, over many tries)", async () => {
    const fifo = join(home, "pipe2");
    execFileSync("mkfifo", [fifo]);
    symlinkSync(world.transcript, join(home, "t3"));
    const count = () => readdirSync("/proc/self/fd").length;
    const before = count();
    for (let i = 0; i < 100; i++) {
      await expect(ops.read.readFile(fifo)).rejects.toThrow(VmFileRefused);
      await expect(ops.read.readFile(home)).rejects.toThrow(VmFileRefused);
      await expect(ops.write.writeFile(join(home, "t3"), "x")).rejects.toThrow(VmFileRefused);
    }
    expect(count()).toBe(before);
  });

  it("lists a link, a dangling link and a file, none of them followed", async () => {
    mkdirSync(join(home, "list"));
    writeFileSync(join(home, "list", "file.txt"), "f");
    symlinkSync(world.transcript, join(home, "list", "link"));
    symlinkSync(join(home, "list", "nowhere"), join(home, "list", "dangling"));
    symlinkSync(world.layout.pi, join(home, "list", "folderlink"));
    const names = ops.ls.readdir(join(home, "list")).sort();
    expect(names).toEqual(["dangling", "file.txt", "folderlink", "link"]);
    for (const name of names) expect(ops.ls.stat(join(home, "list", name)).isDirectory(), name).toBe(false);
    expect(transcript()).toBe("TRANSCRIPT\n");
  });

  it("refuses a read over VM_READ_MAX_BYTES", async () => {
    const big = join(home, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, VM_READ_MAX_BYTES + 1);
    await expect(ops.read.readFile(big)).rejects.toThrow(VmFileRefused);
  });
});

describe("createVmFileOps: what works", () => {
  it("`mkdir` then `writeFile` of a new nested file, read back", async () => {
    const dir = join(home, "a", "b");
    await ops.write.mkdir(dir);
    await ops.write.writeFile(join(dir, "c.txt"), "héllo");
    expect((await ops.read.readFile(join(dir, "c.txt"))).toString("utf8")).toBe("héllo");
    await ops.write.mkdir(dir); // exists: fine
    await ops.write.writeFile(join(dir, "c.txt"), "x"); // truncates
    expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("x");
    await ops.edit.access(join(dir, "c.txt"));
    expect(ops.ls.readdir(dir)).toEqual(["c.txt"]);
    expect(ops.ls.stat(dir).isDirectory()).toBe(true);
    expect(ops.ls.stat(join(dir, "c.txt")).isDirectory()).toBe(false);
    expect(ops.ls.exists(join(dir, "nope"))).toBe(false);
  });

  it("writes the other writable roots", async () => {
    await ops.write.writeFile(join(world.layout.knowledge, "k.md"), "k");
    await ops.write.writeFile(join(world.layout.inbox, "i.md"), "i");
    expect(readFileSync(join(world.layout.knowledge, "k.md"), "utf8")).toBe("k");
  });

  it("reads a hard link inside home", async () => {
    writeFileSync(join(home, "orig.txt"), "same");
    linkSync(join(home, "orig.txt"), join(home, "hard.txt"));
    expect((await ops.read.readFile(join(home, "hard.txt"))).toString()).toBe("same");
  });

  it("detects the image types by their first bytes", async () => {
    writeFileSync(
      join(home, "a.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    );
    writeFileSync(join(home, "b.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    writeFileSync(
      join(home, "c.webp"),
      Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
    );
    writeFileSync(join(home, "d.txt"), "plain text");
    writeFileSync(join(home, "e.txt"), "");
    const detect = (name: string) => ops.read.detectImageMimeType(join(home, name));
    expect(await detect("a.png")).toBe("image/png");
    expect(await detect("b.jpg")).toBe("image/jpeg");
    expect(await detect("c.webp")).toBe("image/webp");
    expect(await detect("d.txt")).toBeNull();
    expect(await detect("e.txt")).toBeNull();
  });
});
