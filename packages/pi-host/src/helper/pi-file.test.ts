import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PI_FILE_BYTES, PiFileRefused, readPiFile, writePiFile } from "./pi-file.ts";

let base = "";
let home = "";
let outside = "";

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pap-pi-file-")));
  home = join(base, "home");
  outside = join(base, "outside");
  await fs.mkdir(home);
  await fs.mkdir(outside);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PiFileRefused);
  return (error as PiFileRefused).reason;
};
const names = async (dir: string): Promise<string[]> => (await fs.readdir(dir)).sort();
const swapFolderForLink = async (dir: string, target: string): Promise<void> => {
  await fs.rename(dir, `${dir}.old`);
  await fs.symlink(target, dir);
};

describe("readPiFile", () => {
  it("reads a regular file and reports its real path and mode", async () => {
    await fs.writeFile(join(home, "models.json"), "{}", { mode: 0o640 });
    expect(await readPiFile(join(home, "models.json"), [home])).toEqual({
      text: "{}",
      real: join(home, "models.json"),
      mode: 0o640,
    });
  });

  it("answers null for a file that does not exist yet, even below missing folders", async () => {
    const result = await readPiFile(join(home, "p", ".pi", "mcp.json"), [home]);
    expect(result).toEqual({ text: null, real: join(home, "p", ".pi", "mcp.json"), mode: null });
  });

  it("follows a dotfiles link that stays inside the roots", async () => {
    await fs.mkdir(join(home, "dotfiles"));
    await fs.writeFile(join(home, "dotfiles", "models.json"), "linked");
    await fs.mkdir(join(home, "agent"));
    await fs.symlink(join(home, "dotfiles", "models.json"), join(home, "agent", "models.json"));
    const result = await readPiFile(join(home, "agent", "models.json"), [home]);
    expect(result.text).toBe("linked");
    expect(result.real).toBe(join(home, "dotfiles", "models.json"));
  });

  it("refuses a file link and a folder link that leave the roots", async () => {
    await fs.writeFile(join(outside, "secret.json"), "x");
    await fs.symlink(join(outside, "secret.json"), join(home, "file-link.json"));
    await fs.symlink(outside, join(home, "folder-link"));
    expect(await refusal(readPiFile(join(home, "file-link.json"), [home]))).toBe("link-outside");
    expect(await refusal(readPiFile(join(home, "folder-link", "secret.json"), [home]))).toBe("link-outside");
  });

  it("refuses a dangling link instead of reading it as no file", async () => {
    await fs.symlink(join(outside, "nowhere.json"), join(home, "dangling.json"));
    expect(await refusal(readPiFile(join(home, "dangling.json"), [home]))).toBe("link-dangling");
  });

  it("refuses a FIFO without blocking", async () => {
    execFileSync("mkfifo", [join(home, "fifo.json")]);
    const reason = await vi.waitFor(() => refusal(readPiFile(join(home, "fifo.json"), [home])), {
      timeout: 2000,
    });
    expect(reason).toBe("not-a-file");
  });

  it("refuses a folder", async () => {
    await fs.mkdir(join(home, "dir.json"));
    expect(await refusal(readPiFile(join(home, "dir.json"), [home]))).toBe("not-a-file");
  });

  it("accepts exactly 1 MiB and refuses 1 MiB + 1", async () => {
    await fs.writeFile(join(home, "full.json"), "a".repeat(MAX_PI_FILE_BYTES));
    await fs.writeFile(join(home, "over.json"), "a".repeat(MAX_PI_FILE_BYTES + 1));
    expect((await readPiFile(join(home, "full.json"), [home])).text?.length).toBe(MAX_PI_FILE_BYTES);
    expect(await refusal(readPiFile(join(home, "over.json"), [home]))).toBe("too-large");
  });

  it("bounds the read by the bytes received, not by the size fstat reported", async () => {
    await fs.writeFile(join(home, "grows.json"), "a".repeat(MAX_PI_FILE_BYTES + 10));
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      vi.spyOn(handle, "stat").mockImplementation(async () => {
        const info = await fs.stat(join(home, "grows.json"));
        return Object.assign(info, { size: 10 });
      });
      return handle;
    });
    expect(await refusal(readPiFile(join(home, "grows.json"), [home]))).toBe("too-large");
  });

  it("reads a file that has another hard link", async () => {
    await fs.writeFile(join(home, "a.json"), "x");
    await fs.link(join(home, "a.json"), join(home, "b.json"));
    expect((await readPiFile(join(home, "a.json"), [home])).text).toBe("x");
  });

  it("refuses a link loop as dangling and a socket as not a file", async () => {
    await fs.symlink(join(home, "loop-b"), join(home, "loop-a"));
    await fs.symlink(join(home, "loop-a"), join(home, "loop-b"));
    expect(await refusal(readPiFile(join(home, "loop-a"), [home]))).toBe("link-dangling");
    const server = createServer();
    await new Promise<void>((done) => server.listen(join(home, "sock"), done));
    try {
      expect(await refusal(readPiFile(join(home, "sock"), [home]))).toBe("not-a-file");
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it("refuses a dangling link on a parent folder instead of reading no file", async () => {
    await fs.mkdir(join(home, "p"));
    await fs.symlink(join(outside, "new"), join(home, "p", ".pi"));
    expect(await refusal(readPiFile(join(home, "p", ".pi", "mcp.json"), [home]))).toBe("link-dangling");
  });

  it("refuses roots that would accept anything", async () => {
    await fs.writeFile(join(home, "a.json"), "x");
    for (const roots of [["/"], [""], ["relative"]])
      expect(await refusal(readPiFile(join(home, "a.json"), roots))).toBe("link-outside");
  });

  it("refuses when the agent folder, itself a root, is swapped for a link", async () => {
    await fs.mkdir(join(home, "agent"));
    await fs.writeFile(join(home, "agent", "auth.json"), "mine");
    await fs.writeFile(join(outside, "auth.json"), "theirs");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      await swapFolderForLink(join(home, "agent"), outside);
      return open(...args);
    });
    expect(await refusal(readPiFile(join(home, "agent", "auth.json"), [join(home, "agent"), home]))).toBe(
      "link-outside",
    );
  });

  it("refuses when a folder is swapped for a link between the check and the open", async () => {
    await fs.mkdir(join(home, "agent"));
    await fs.writeFile(join(home, "agent", "auth.json"), "mine");
    await fs.writeFile(join(outside, "auth.json"), "theirs");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      await swapFolderForLink(join(home, "agent"), outside);
      return open(...args);
    });
    expect(await refusal(readPiFile(join(home, "agent", "auth.json"), [home]))).toBe("link-outside");
  });

  it("fails closed when the opened descriptor cannot be judged", async () => {
    await fs.writeFile(join(home, "a.json"), "x");
    const readlink = fs.readlink.bind(fs);
    vi.spyOn(fs, "readlink").mockImplementation(async (path, ...rest) => {
      if (String(path).startsWith("/proc/self/fd/"))
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return readlink(path, ...rest);
    });
    expect(await refusal(readPiFile(join(home, "a.json"), [home]))).toBe("link-outside");
  });
});

describe("writePiFile", () => {
  const opts = { roots: [] as string[], mode: 0o600, keepMode: false };

  it("writes a new file with the given mode and creates its folders", async () => {
    const path = join(home, "p", ".pi", "mcp.json");
    await writePiFile(path, "new", { ...opts, roots: [home], mode: 0o600 });
    expect(await fs.readFile(path, "utf8")).toBe("new");
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await names(join(home, "p", ".pi"))).toEqual(["mcp.json"]);
  });

  it("keeps the old mode with keepMode and sets the given one without", async () => {
    const path = join(home, "settings.json");
    await fs.writeFile(path, "old", { mode: 0o640 });
    await fs.chmod(path, 0o640);
    await writePiFile(path, "one", { ...opts, roots: [home], mode: 0o600, keepMode: true });
    expect((await fs.stat(path)).mode & 0o777).toBe(0o640);
    await writePiFile(path, "two", { ...opts, roots: [home], mode: 0o600, keepMode: false });
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path, "utf8")).toBe("two");
    expect(await names(home)).toEqual(["settings.json"]);
  });

  it("writes through a dotfiles link in place and the link stays a link", async () => {
    await fs.mkdir(join(home, "dotfiles"));
    await fs.writeFile(join(home, "dotfiles", "models.json"), "old");
    await fs.mkdir(join(home, "agent"));
    await fs.symlink(join(home, "dotfiles", "models.json"), join(home, "agent", "models.json"));
    await writePiFile(join(home, "agent", "models.json"), "new", { ...opts, roots: [home] });
    expect((await fs.lstat(join(home, "agent", "models.json"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(join(home, "dotfiles", "models.json"), "utf8")).toBe("new");
  });

  it("refuses a link out of the roots, file or folder, and creates nothing", async () => {
    await fs.writeFile(join(outside, "target.json"), "keep");
    await fs.symlink(join(outside, "target.json"), join(home, "file-link.json"));
    await fs.symlink(outside, join(home, "folder-link"));
    expect(await refusal(writePiFile(join(home, "file-link.json"), "x", { ...opts, roots: [home] }))).toBe(
      "link-outside",
    );
    expect(
      await refusal(writePiFile(join(home, "folder-link", "new.json"), "x", { ...opts, roots: [home] })),
    ).toBe("link-outside");
    expect(
      await refusal(
        writePiFile(join(home, "folder-link", "sub", "new.json"), "x", { ...opts, roots: [home] }),
      ),
    ).toBe("link-outside");
    expect(await names(outside)).toEqual(["target.json"]);
    expect(await fs.readFile(join(outside, "target.json"), "utf8")).toBe("keep");
  });

  it("refuses a dangling link and creates nothing at its target", async () => {
    await fs.symlink(join(outside, "nowhere.json"), join(home, "dangling.json"));
    expect(await refusal(writePiFile(join(home, "dangling.json"), "x", { ...opts, roots: [home] }))).toBe(
      "link-dangling",
    );
    expect(await names(outside)).toEqual([]);
  });

  it("refuses a dangling link on a parent folder and creates nothing", async () => {
    await fs.mkdir(join(home, "p"));
    await fs.symlink(join(outside, "new"), join(home, "p", ".pi"));
    expect(
      await refusal(writePiFile(join(home, "p", ".pi", "mcp.json"), "x", { ...opts, roots: [home] })),
    ).toBe("link-dangling");
    expect(
      await refusal(writePiFile(join(home, "p", ".pi", "sub", "x.json"), "x", { ...opts, roots: [home] })),
    ).toBe("link-dangling");
    expect(await names(outside)).toEqual([]);
  });

  it("gives a new file the requested mode whatever it is", async () => {
    await writePiFile(join(home, "new.json"), "x", { ...opts, roots: [home], mode: 0o644 });
    expect((await fs.stat(join(home, "new.json"))).mode & 0o777).toBe(0o644);
  });

  it("refuses when the agent folder, itself a root, is swapped for a link", async () => {
    await fs.mkdir(join(home, "agent"));
    await fs.writeFile(join(home, "agent", "auth.json"), "mine");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      await swapFolderForLink(join(home, "agent"), outside);
      return open(...args);
    });
    expect(
      await refusal(
        writePiFile(join(home, "agent", "auth.json"), "SECRET", {
          ...opts,
          roots: [join(home, "agent"), home],
        }),
      ),
    ).toBe("link-outside");
    expect(await names(outside)).toEqual([]);
  });

  it("reports a refusal under its own name and keeps the original error when cleanup fails", async () => {
    const error = new PiFileRefused("hard-link");
    expect(error.name).toBe("PiFileRefused");
    const path = join(home, "settings.json");
    await fs.writeFile(path, "old");
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("injected"));
    vi.spyOn(fs, "rm").mockRejectedValue(new Error("cleanup"));
    await expect(writePiFile(path, "new", { ...opts, roots: [home] })).rejects.toThrow("injected");
  });

  it("syncs the folder after the rename", async () => {
    const synced: string[] = [];
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        synced.push(String(args[0]));
        return sync();
      });
      return handle;
    });
    await writePiFile(join(home, "a.json"), "x", { ...opts, roots: [home] });
    expect(synced.map((path) => (path === home ? "folder" : "file"))).toEqual(["file", "folder"]);
  });

  it("refuses a FIFO and a folder as the target without blocking", async () => {
    execFileSync("mkfifo", [join(home, "fifo.json")]);
    await fs.mkdir(join(home, "dir.json"));
    expect(await refusal(writePiFile(join(home, "fifo.json"), "x", { ...opts, roots: [home] }))).toBe(
      "not-a-file",
    );
    expect(await refusal(writePiFile(join(home, "dir.json"), "x", { ...opts, roots: [home] }))).toBe(
      "not-a-file",
    );
  });

  it("refuses a target with another hard link and leaves both names alone", async () => {
    await fs.writeFile(join(home, "a.json"), "x");
    await fs.link(join(home, "a.json"), join(home, "b.json"));
    expect(await refusal(writePiFile(join(home, "a.json"), "y", { ...opts, roots: [home] }))).toBe(
      "hard-link",
    );
    expect(await fs.readFile(join(home, "b.json"), "utf8")).toBe("x");
    expect(await names(home)).toEqual(["a.json", "b.json"]);
  });

  it("accepts 1 MiB and refuses 1 MiB + 1 before touching the disk", async () => {
    await writePiFile(join(home, "full.json"), "a".repeat(MAX_PI_FILE_BYTES), { ...opts, roots: [home] });
    expect((await fs.stat(join(home, "full.json"))).size).toBe(MAX_PI_FILE_BYTES);
    expect(
      await refusal(
        writePiFile(join(home, "over.json"), "a".repeat(MAX_PI_FILE_BYTES + 1), { ...opts, roots: [home] }),
      ),
    ).toBe("too-large");
    expect(await names(home)).toEqual(["full.json"]);
  });

  it("keeps the old content and leaves no temporary file after a failed rename", async () => {
    const path = join(home, "settings.json");
    await fs.writeFile(path, "old");
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("injected"));
    await expect(writePiFile(path, "new", { ...opts, roots: [home] })).rejects.toThrow("injected");
    expect(await fs.readFile(path, "utf8")).toBe("old");
    expect(await names(home)).toEqual(["settings.json"]);
  });

  it("leaves no temporary file after a failed write or sync", async () => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      vi.spyOn(handle, "sync").mockRejectedValue(new Error("disk full"));
      return handle;
    });
    await expect(writePiFile(join(home, "settings.json"), "new", { ...opts, roots: [home] })).rejects.toThrow(
      "disk full",
    );
    expect(await names(home)).toEqual([]);
  });

  it("refuses and cleans up when a folder is swapped for a link before the temporary file opens", async () => {
    await fs.mkdir(join(home, "agent"));
    await fs.writeFile(join(home, "agent", "auth.json"), "mine");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      await swapFolderForLink(join(home, "agent"), outside);
      return open(...args);
    });
    expect(
      await refusal(writePiFile(join(home, "agent", "auth.json"), "new", { ...opts, roots: [home] })),
    ).toBe("link-outside");
    expect(await names(outside)).toEqual([]);
    expect(await fs.readFile(join(home, "agent.old", "auth.json"), "utf8")).toBe("mine");
  });
});
