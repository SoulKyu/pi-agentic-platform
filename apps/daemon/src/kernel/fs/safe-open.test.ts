import { execFileSync } from "node:child_process";
import {
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createBoundaryBed } from "../testing/boundary-bed.ts";
import { createDenySet } from "./deny-set.ts";
import {
  BoundaryError,
  FOLDER_FLAGS,
  isTempName,
  openFolder,
  openRegularFile,
  READ_FLAGS,
  TEMP_FLAGS,
  writeAtomic,
  type OpenGuard,
} from "./safe-open.ts";

let bed: ReturnType<typeof createBoundaryBed>;
beforeEach(() => {
  bed = createBoundaryBed();
  bed.file(join(bed.papHome, "secrets", "k"), "SECRET");
  bed.file(join(bed.agentDir, "auth.json"), "SECRET");
  bed.file(join(bed.papHome, "state.db"), "SECRET");
});
afterEach(() => bed.dispose());

const guardOf = (
  root: string,
  caller: "session" | "token" = "session",
  now = Date.now() + 3_600_000,
): OpenGuard => ({
  root,
  roots: [root],
  config: bed.config(),
  caller,
  deny: createDenySet(bed.denySources(), createFakeClock(now)),
});

const reasonOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof BoundaryError ? error.reason : `${(error as NodeJS.ErrnoException).code}`;
  }
  return "no error";
};
const readAll = async (path: string, guard: OpenGuard): Promise<string> => {
  const handle = await openRegularFile(path, guard);
  try {
    return (await handle.readFile()).toString();
  } finally {
    await handle.close();
  }
};
const leftovers = (folder: string): string[] => readdirSync(folder).filter(isTempName);
const chunks = (...texts: string[]) => texts.map((t) => Buffer.from(t));

describe("openRegularFile", () => {
  it("reads a regular file", async () => {
    expect(await readAll(join(bed.proj, "a.txt"), guardOf(bed.home))).toBe("x");
  });

  it("refuses a hard link to a private file, whichever it is", async () => {
    const targets = [
      join(bed.agentDir, "auth.json"),
      join(bed.papHome, "state.db"),
      join(bed.papHome, "secrets", "k"),
      join(bed.agentDir, "sessions", "x", "a.jsonl"),
    ];
    let n = 0;
    for (const target of targets) {
      const alias = join(bed.proj, `notes${n++}.txt`);
      linkSync(target, alias);
      expect(await reasonOf(() => readAll(alias, guardOf(bed.home))), target).toBe("denied");
    }
  });

  it("refuses a hard link to a session file created a moment ago", async () => {
    const fresh = join(bed.agentDir, "sessions", "x", "fresh.jsonl");
    const guard = guardOf(bed.home, "session", Date.now() - 3_600_000);
    expect(await readAll(join(bed.proj, "a.txt"), guard)).toBe("x");
    bed.file(fresh, "SECRET");
    const alias = join(bed.proj, "fresh.txt");
    linkSync(fresh, alias);
    expect(await reasonOf(() => readAll(alias, guard))).toBe("denied");
  });

  it("serves an ordinary file with two names", async () => {
    const alias = join(bed.proj, "a2.txt");
    linkSync(join(bed.proj, "a.txt"), alias);
    expect(await readAll(alias, guardOf(bed.home))).toBe("x");
  });

  it("refuses a folder swapped for a link into pap's home", async () => {
    bed.file(join(bed.home, "x", "plain.txt"), "SECRET");
    bed.file(join(bed.papHome, "plain.txt"), "SECRET");
    const real = join(bed.home, "x", "plain.txt");
    rmSync(join(bed.home, "x"), { recursive: true });
    symlinkSync(bed.papHome, join(bed.home, "x"));
    expect(await reasonOf(() => readAll(real, guardOf(bed.home)))).toBe("moved");
    expect(await reasonOf(() => readAll(join(bed.home, "x", "state.db"), guardOf(bed.home)))).toBe("moved");
  });

  it("refuses a folder swapped for a link out of the judged root", async () => {
    bed.file(join(bed.outside, "plain.txt"), "outside");
    symlinkSync(bed.outside, join(bed.proj, "sw"));
    expect(await reasonOf(() => readAll(join(bed.proj, "sw", "plain.txt"), guardOf(bed.proj)))).toBe("moved");
  });

  it("refuses a final component swapped for a link", async () => {
    symlinkSync(join(bed.outside, "secret.txt"), join(bed.proj, "swap.txt"));
    expect(await reasonOf(() => readAll(join(bed.proj, "swap.txt"), guardOf(bed.home)))).toBe("ELOOP");
  });

  it("refuses a FIFO without blocking", async () => {
    const fifo = join(bed.proj, "pipe");
    execFileSync("mkfifo", [fifo]);
    expect(await reasonOf(() => readAll(fifo, guardOf(bed.home)))).toBe("not_regular");
  }, 5000);

  it("applies a token's hidden names to the descriptor", async () => {
    const path = join(bed.proj, ".pi", "mcp.json");
    expect(await readAll(path, guardOf(bed.proj))).toBe("x");
    expect(await reasonOf(() => readAll(path, guardOf(bed.proj, "token")))).toBe("moved");
  });
});

describe("descriptors of the boundary", () => {
  it("never become a controlling terminal", () => {
    for (const flags of [READ_FLAGS, FOLDER_FLAGS, TEMP_FLAGS])
      expect(flags & constants.O_NOCTTY).toBe(constants.O_NOCTTY);
  });

  it("are refused when /proc cannot say where they are (a path past 4 KiB)", async () => {
    // Each hop adds 2 000 bytes of real folders behind a link: the real path ends up past PATH_MAX.
    let tip = join(bed.outside, "deep");
    for (let hop = 0; hop < 3; hop++) {
      const link = join(bed.base, `hop${hop}`);
      symlinkSync(tip, link);
      tip = join(link, ...Array.from({ length: 10 }, (_, i) => `${"d".repeat(199)}${i}`));
      mkdirSync(tip, { recursive: true });
    }
    writeFileSync(join(tip, "secret.txt"), "SECRET");
    symlinkSync(tip, join(bed.proj, "sw"));
    expect(await reasonOf(() => readAll(join(bed.proj, "sw", "secret.txt"), guardOf(bed.home)))).toBe(
      "moved",
    );
    expect(
      await reasonOf(() => readAll(join(bed.proj, "sw", "secret.txt"), guardOf(bed.home, "token"))),
    ).toBe("moved");
  });
});

describe("openFolder", () => {
  it("lists through the descriptor", async () => {
    bed.file(join(bed.home, "x", "plain.txt"));
    const opened = await openFolder(join(bed.home, "x"), guardOf(bed.home));
    try {
      expect(opened.path.startsWith("/proc/self/fd/")).toBe(true);
      expect(await readdir(opened.path)).toEqual(["plain.txt"]);
      expect((await lstat(join(opened.path, "plain.txt"))).isFile()).toBe(true);
    } finally {
      await opened.close();
    }
  });

  it("refuses a folder that became a link", async () => {
    symlinkSync(bed.outside, join(bed.home, "lnk"));
    expect(await reasonOf(() => openFolder(join(bed.home, "lnk"), guardOf(bed.home)))).toBe("ENOTDIR");
  });

  it("refuses a middle folder that became a link into pap's home", async () => {
    symlinkSync(bed.papHome, join(bed.home, "mid"));
    expect(await reasonOf(() => openFolder(join(bed.home, "mid", "secrets"), guardOf(bed.home)))).toBe(
      "moved",
    );
  });
});

describe("writeAtomic", () => {
  const input = (real: string, guard: OpenGuard, over: Partial<Parameters<typeof writeAtomic>[0]> = {}) => ({
    real,
    guard,
    chunks: chunks("hello"),
    maxBytes: 100,
    mode: 0o644,
    replace: true,
    ...over,
  });

  it("creates the file with the given mode under umask 077", async () => {
    const before = process.umask(0o077);
    try {
      const real = join(bed.proj, "new.txt");
      expect(await writeAtomic(input(real, guardOf(bed.home)))).toBe(5);
      expect(readFileSync(real, "utf8")).toBe("hello");
      expect(statSync(real).mode & 0o777).toBe(0o644);
      expect(leftovers(bed.proj)).toEqual([]);
    } finally {
      process.umask(before);
    }
  });

  it("refuses a swapped folder and leaves nothing in pap's home", async () => {
    symlinkSync(bed.papHome, join(bed.home, "x"));
    expect(await reasonOf(() => writeAtomic(input(join(bed.home, "x", "n.txt"), guardOf(bed.home))))).toBe(
      "moved",
    );
    expect(readFileSync(join(bed.papHome, "state.db"), "utf8")).toBe("SECRET");
    expect(leftovers(bed.papHome)).toEqual([]);
  });

  it("writes a file directly in the home folder for a token, the temporary name being no one's business", async () => {
    const real = join(bed.home, "notes.md");
    expect(await writeAtomic(input(real, guardOf(bed.home, "token")))).toBe(5);
    expect(readFileSync(real, "utf8")).toBe("hello");
    expect(leftovers(bed.home)).toEqual([]);
  });

  it("still refuses a token a destination that is a home dot-entry", async () => {
    expect(
      await reasonOf(() => writeAtomic(input(join(bed.home, ".bashrc"), guardOf(bed.home, "token")))),
    ).toBe("moved");
    expect(leftovers(bed.home)).toEqual([]);
  });

  it("never replaces a hard link to a private file", async () => {
    const alias = join(bed.proj, "notes.txt");
    linkSync(join(bed.agentDir, "auth.json"), alias);
    expect(await reasonOf(() => writeAtomic(input(alias, guardOf(bed.home))))).toBe("denied");
    expect(readFileSync(join(bed.agentDir, "auth.json"), "utf8")).toBe("SECRET");
    expect(leftovers(bed.proj)).toEqual([]);
  });

  it("does not replace an existing file when replace is false", async () => {
    const real = join(bed.proj, "a.txt");
    expect(await reasonOf(() => writeAtomic(input(real, guardOf(bed.home), { replace: false })))).toBe(
      "exists",
    );
    expect(readFileSync(real, "utf8")).toBe("x");
    expect(leftovers(bed.proj)).toEqual([]);
  });

  it("places a new file without hard links by rename, and still refuses to replace", async () => {
    const real = join(bed.proj, "vfat.txt");
    const noLink = (): Promise<void> =>
      Promise.reject(Object.assign(new Error("no links"), { code: "EPERM" }));
    const guard = guardOf(bed.home);
    await writeAtomic(input(real, guard, { replace: false }), noLink);
    expect(readFileSync(real, "utf8")).toBe("hello");
    expect(await reasonOf(() => writeAtomic(input(real, guard, { replace: false }), noLink))).toBe("exists");
    expect(readFileSync(real, "utf8")).toBe("hello");
    expect(leftovers(bed.proj)).toEqual([]);
  });

  it("stops a stream past maxBytes", async () => {
    const real = join(bed.proj, "big.txt");
    expect(
      await reasonOf(() =>
        writeAtomic(input(real, guardOf(bed.home), { chunks: chunks("abc", "defg"), maxBytes: 6 })),
      ),
    ).toBe("too_large");
    expect(() => lstatSync(real)).toThrow();
    expect(leftovers(bed.proj)).toEqual([]);
  });

  it("keeps the original when the stream throws", async () => {
    const real = join(bed.proj, "a.txt");
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("par");
      throw new Error("boom");
    }
    await expect(writeAtomic(input(real, guardOf(bed.home), { chunks: broken() }))).rejects.toThrow("boom");
    expect(readFileSync(real, "utf8")).toBe("x");
    expect(leftovers(bed.proj)).toEqual([]);
  });

  it("writes through a link inside the root and keeps the link", async () => {
    symlinkSync(join(bed.proj, "a.txt"), join(bed.proj, "lnk"));
    await writeAtomic(input(join(bed.proj, "a.txt"), guardOf(bed.home)));
    expect(readFileSync(join(bed.proj, "lnk"), "utf8")).toBe("hello");
    expect(lstatSync(join(bed.proj, "lnk")).isSymbolicLink()).toBe(true);
  });
});
