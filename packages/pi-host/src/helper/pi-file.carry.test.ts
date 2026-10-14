import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiFileRefused, readPiFile, writePiFile } from "./pi-file.ts";

let base = "";
let home = "";
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pap-pi-file-carry-")));
  home = join(base, "home");
  await fs.mkdir(home);
  await fs.writeFile(join(home, "a.json"), "old");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PiFileRefused);
  return (error as PiFileRefused).reason;
};

describe("a root that names the filesystem root is refused by its real path", () => {
  it.each(["//", "/.", "/tmp/.."])("refuses the root %s for a read and a write", async (root) => {
    expect(await reasonOf(readPiFile(join(home, "a.json"), [root]))).toBe("link-outside");
    expect(
      await reasonOf(
        writePiFile(join(home, "a.json"), "new", { roots: [root], mode: 0o600, keepMode: false }),
      ),
    ).toBe("link-outside");
    expect(await fs.readFile(join(home, "a.json"), "utf8")).toBe("old");
  });

  it("refuses a root that is a link to /", async () => {
    await fs.symlink("/", join(base, "rootlink"));
    expect(await reasonOf(readPiFile(join(home, "a.json"), [join(base, "rootlink")]))).toBe("link-outside");
  });

  it("still accepts an ordinary root", async () => {
    expect((await readPiFile(join(home, "a.json"), [home])).text).toBe("old");
  });
});

describe("a folder sync failing after the rename", () => {
  const failFolderOpen = (code: string) => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === home) throw Object.assign(new Error("injected"), { code });
      return open(...args);
    });
  };

  it("reports the write as done and tells the caller which error code it saw", async () => {
    failFolderOpen("EIO");
    const seen: string[] = [];
    await writePiFile(join(home, "a.json"), "new", {
      roots: [home],
      mode: 0o600,
      keepMode: false,
      onFolderSyncFailed: (code) => seen.push(code),
    });
    expect(await fs.readFile(join(home, "a.json"), "utf8")).toBe("new");
    expect(seen).toEqual(["EIO"]);
    expect((await fs.readdir(home)).sort()).toEqual(["a.json"]);
  });

  it("answers ok without a listener too", async () => {
    failFolderOpen("EINVAL");
    await expect(
      writePiFile(join(home, "a.json"), "new", { roots: [home], mode: 0o600, keepMode: false }),
    ).resolves.toBeUndefined();
  });

  it("still fails a write whose rename failed", async () => {
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("injected"));
    await expect(
      writePiFile(join(home, "a.json"), "new", { roots: [home], mode: 0o600, keepMode: false }),
    ).rejects.toThrow("injected");
    expect(await fs.readFile(join(home, "a.json"), "utf8")).toBe("old");
  });
});
