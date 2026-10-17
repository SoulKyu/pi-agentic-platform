import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { checkReadTarget, readsInside, readsRunsFolder, type ReadDirs } from "./read-target.ts";

const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
const OTHER_TASK = "ffffffff-0000-4000-8000-0123456789ab";
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let agents: string;
let atlas: string;
let scout: string;
let runs: string;
let scratch: string;
let otherScratch: string;
let scoutRuns: string;

beforeEach(async () => {
  bed = await createPipelineBed();
  agents = join(bed.papHome, "agents");
  atlas = join(agents, "atlas-1a2b");
  scout = join(agents, "scout-0000");
  runs = join(agents, ".runs", "atlas-1a2b");
  scratch = join(runs, TASK);
  otherScratch = join(runs, OTHER_TASK);
  scoutRuns = join(agents, ".runs", "scout-0000", TASK);
  for (const dir of [atlas, scout, scratch, otherScratch, scoutRuns, join(agents, ".trash", "old")])
    await mkdir(dir, { recursive: true });
  for (const file of [
    join(atlas, "MEMORY.md"),
    join(scout, "MEMORY.md"),
    join(scratch, "out.txt"),
    join(otherScratch, "out.txt"),
    join(scoutRuns, "out.txt"),
    join(agents, ".trash", "old", "MEMORY.md"),
  ])
    await writeFile(file, "x");
  await writeFile(join(bed.papHome, "state.db"), "x");
});
afterEach(() => bed.dispose());

const plain = (cwd: string): ReadDirs => ({ cwd, papHome: bed.papHome, agentDir: bed.agentDir });
const thread = (): ReadDirs => ({ ...plain(atlas), profile: "agent-thread", agentHome: atlas });
const task = (): ReadDirs => ({
  ...plain(scratch),
  profile: "isolated-task",
  agentHome: atlas,
  agentScratch: scratch,
});
const asks = async (tool: string, path: unknown, dirs: ReadDirs) =>
  (await checkReadTarget(tool, { path }, dirs))?.why;

describe("protected reads of the agents' folders (M11R29)", () => {
  it("asks a plain session for any agent's notes, even in the folder it was opened in", async () => {
    expect(await asks("read", join(scout, "MEMORY.md"), plain(bed.cwd))).toBe("protected path");
    expect(await asks("read", "MEMORY.md", plain(atlas))).toBe("protected path");
  });

  it("lets the thread read its own home and asks for another agent's", async () => {
    expect(await asks("read", "MEMORY.md", thread())).toBeUndefined();
    expect(await asks("grep", atlas, thread())).toBeUndefined();
    expect(await asks("read", join(scout, "MEMORY.md"), thread())).toBe("protected path");
    expect(await asks("read", `${atlas}/../scout-0000/MEMORY.md`, thread())).toBe("protected path");
  });

  it("asks for the trash in every session", async () => {
    const trashed = join(agents, ".trash", "old", "MEMORY.md");
    expect(await asks("read", trashed, thread())).toBe("protected path");
    expect(await asks("read", trashed, task())).toBe("protected path");
    expect(await asks("read", trashed, plain(bed.cwd))).toBe("protected path");
  });

  it("asks for the runs folders but the thread's own agent's and the task's own scratch folder", async () => {
    const mine = join(scratch, "out.txt");
    expect(await asks("read", mine, plain(bed.cwd))).toBe("protected path");
    expect(await asks("read", mine, thread())).toBeUndefined();
    expect(await asks("read", join(otherScratch, "out.txt"), thread())).toBeUndefined();
    expect(await asks("ls", runs, thread())).toBeUndefined();
    expect(await asks("read", join(scoutRuns, "out.txt"), thread())).toBe("protected path");
    expect(await asks("read", mine, task())).toBeUndefined();
    expect(await asks("read", join(otherScratch, "out.txt"), task())).toBe("protected path");
    expect(await asks("read", join(atlas, "MEMORY.md"), task())).toBeUndefined();
  });

  it("asks for a search rooted above the agents' folders, and for none of the listing of agents/", async () => {
    expect(await asks("grep", agents, thread())).toBe("protected path");
    expect(await asks("find", join(agents, ".runs"), thread())).toBe("protected path");
    expect(await asks("ls", agents, thread())).toBeUndefined();
  });

  it("asks for a symlink of the home that leads to another agent", async () => {
    await symlink(join(scout, "MEMORY.md"), join(atlas, "peek.md"));
    expect(await asks("read", "peek.md", thread())).toBe("protected path");
  });

  it("ignores the agent folders the rules of an interactive session carry", async () => {
    const dirs: ReadDirs = { ...plain(atlas), profile: "interactive", agentHome: atlas };
    expect(await asks("read", "MEMORY.md", dirs)).toBe("protected path");
  });

  it("does not take a home that is no agent home for the session's own", async () => {
    const dirs: ReadDirs = { ...thread(), agentHome: join(bed.papHome, "secrets") };
    expect(await asks("read", "MEMORY.md", dirs)).toBe("protected path");
  });
});

describe("readsInside (M11R33)", () => {
  const roots = () => [atlas, scratch];
  it("accepts a home file from the scratch cwd and a scratch file", async () => {
    expect(await readsInside([join(atlas, "MEMORY.md")], scratch, roots())).toBe(true);
    expect(await readsInside(["out.txt"], scratch, roots())).toBe(true);
    expect(await readsInside([scratch], scratch, roots())).toBe(true);
  });

  it("takes the cwd for a call that names no path", async () => {
    expect(await readsInside([], scratch, roots())).toBe(true);
    expect(await readsInside([], bed.cwd, roots())).toBe(false);
  });

  it("refuses a way out of both folders", async () => {
    expect(await readsInside(["../../../../state.db"], scratch, roots())).toBe(false);
    expect(await readsInside([`${atlas}/../scout-0000/MEMORY.md`], scratch, roots())).toBe(false);
    expect(await readsInside([bed.papHome], scratch, roots())).toBe(false);
  });

  it("refuses a symlink of the scratch folder that points out, and another task's folder", async () => {
    await symlink(join(scout, "MEMORY.md"), join(scratch, "peek.md"));
    await symlink(bed.outside, join(scratch, "door"), "dir");
    expect(await readsInside(["peek.md"], scratch, roots())).toBe(false);
    expect(await readsInside(["door"], scratch, roots())).toBe(false);
    expect(await readsInside([join(otherScratch, "out.txt")], scratch, roots())).toBe(false);
  });

  it("reads `..` after a symlink the way the kernel does", async () => {
    await mkdir(join(bed.outside, "deep"), { recursive: true });
    await symlink(join(bed.outside, "deep"), join(scratch, "link"), "dir");
    expect(await readsInside(["link/.."], scratch, roots())).toBe(false);
  });

  it("reads `..` before a symlink the way Pi does", async () => {
    await mkdir(join(scratch, "p", "q", "r", "s"), { recursive: true });
    await symlink(join(scratch, "p", "q", "r", "s"), join(scratch, "link"), "dir");
    // Pi collapses `link/..` first and lands in agents/; the kernel lands in the scratch folder. Both files exist.
    await writeFile(join(scratch, "x"), "x");
    await writeFile(join(agents, "x"), "x");
    expect(await readsInside(["link/../../../../x"], scratch, roots())).toBe(false);
  });

  it("refuses a missing path, because Pi retries missing paths with rewritten spellings", async () => {
    expect(await readsInside([join(scratch, "nope.txt")], scratch, roots())).toBe(false);
  });

  // Each spelling exists inside the scratch folder (and so does the one Pi rewrites it to): only the rule itself refuses.
  it.each([
    ["a tilde path", "~/x"],
    ["an at-sign path", "@out.txt"],
    ["a file URL", "file:out.txt"],
    ["a narrow no-break space", "out\u202F.txt"],
    ["an ideographic space", "\u3000out.txt"],
    ["a byte order mark", "\uFEFFout.txt"],
    ["a line separator", "out\u2028.txt"],
  ])("refuses %s even when it exists", async (_name, path) => {
    const home = join(scratch, "h");
    vi.stubEnv("HOME", home);
    try {
      await mkdir(join(scratch, "~"), { recursive: true });
      await mkdir(home, { recursive: true });
      for (const file of [
        join(scratch, "~", "x"),
        join(home, "x"),
        join(scratch, path),
        join(scratch, path.replace(/^[@\u3000\uFEFF]|file:/, "")),
        join(scratch, "out .txt"),
      ])
        await writeFile(file, "x");
      expect(await readsInside([path], scratch, roots())).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["a NUL", "out\0.txt"],
    ["an empty path", ""],
    ["a number", 5],
    ["a null", null],
  ])("refuses %s", async (_name, path) => {
    expect(await readsInside([path], scratch, roots())).toBe(false);
  });

  it("refuses one outside path among inside ones", async () => {
    expect(await readsInside(["out.txt", bed.outside], scratch, roots())).toBe(false);
  });
});

describe("readsRunsFolder (M11R181)", () => {
  const reads = (tool: string, path: unknown, cwd = atlas) =>
    readsRunsFolder(tool, { path }, { cwd, papHome: bed.papHome });
  it("sees a read, grep, find or ls of the runs folders in any spelling", async () => {
    const alias = join(bed.base, "alias");
    await symlink(bed.papHome, alias, "dir");
    expect(await reads("read", join(scratch, "out.txt"))).toBe(true);
    expect(await reads("ls", runs)).toBe(true);
    expect(await reads("read", join(alias, "agents", ".runs", "atlas-1a2b", TASK, "out.txt"))).toBe(true);
    expect(await reads("read", `${atlas}/../.runs/atlas-1a2b/${TASK}/out.txt`)).toBe(true);
    expect(await reads("read", join(scratch, "missing.txt"))).toBe(true);
  });

  it("sees a path that reaches the runs folder only the way the kernel reads it", async () => {
    await mkdir(join(scratch, "sub"), { recursive: true });
    await symlink(join(scratch, "sub"), join(atlas, "rl"), "dir");
    expect(await reads("read", "rl/../out.txt")).toBe(true);
  });

  it("sees a search that starts above the runs folders, not a listing", async () => {
    expect(await reads("grep", agents)).toBe(true);
    expect(await reads("find", bed.papHome)).toBe(true);
    expect(await reads("ls", agents)).toBe(false);
  });

  it("does not see the home, a call without a path from the home, or any other tool", async () => {
    expect(await reads("read", "MEMORY.md")).toBe(false);
    expect(await readsRunsFolder("grep", { pattern: "x" }, { cwd: atlas, papHome: bed.papHome })).toBe(false);
    expect(await reads("write", join(scratch, "out.txt"))).toBe(false);
  });

  it("takes a call without a path from a scratch folder for a read of the runs folders", async () => {
    expect(await readsRunsFolder("grep", { pattern: "x" }, { cwd: scratch, papHome: bed.papHome })).toBe(
      true,
    );
  });

  it("counts a path it cannot read as external", async () => {
    expect(await reads("read", 5)).toBe(true);
  });
});
