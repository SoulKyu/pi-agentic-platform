import { link as hardLink, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { checkEditTarget, ownFolder } from "./target-path.ts";

const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
const OTHER_TASK = "ffffffff-0000-4000-8000-0123456789ab";
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let agents: string;
let atlas: string;
let scout: string;
let scratch: string;
let alias: string;

beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
  await mkdir(join(bed.base, "home"), { recursive: true });
  agents = join(bed.papHome, "agents");
  atlas = join(agents, "atlas-1a2b");
  scout = join(agents, "scout-0000");
  scratch = join(agents, ".runs", "atlas-1a2b", TASK);
  for (const dir of [
    atlas,
    scout,
    scratch,
    join(agents, ".trash", "old"),
    join(agents, ".runs", "atlas-1a2b", OTHER_TASK),
  ])
    await mkdir(dir, { recursive: true });
  await mkdir(join(atlas, ".git"), { recursive: true });
  await writeFile(join(bed.papHome, "state.db"), "x");
  alias = join(bed.base, "pap-alias");
  await symlink(bed.papHome, alias, "dir");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

const check = (path: unknown, cwd: string, own: string | null) =>
  checkEditTarget(path, cwd, [bed.agentDir, bed.papHome], bed.papHome, own);
const why = async (path: unknown, cwd: string, own: string | null) => {
  const result = await check(path, cwd, own);
  return result.auto ? "auto" : result.review.why;
};

describe("an agent thread edits the folder its rules name (M11R28)", () => {
  it("edits MEMORY.md in its home unasked", async () => {
    expect(await why("MEMORY.md", atlas, atlas)).toBe("auto");
    expect(await why(join(atlas, "notes", "a.md"), atlas, atlas)).toBe("auto");
  });

  it("asks for another agent's home, the trash, the runs folders and the rest of pap's home", async () => {
    expect(await why(join(scout, "MEMORY.md"), atlas, atlas)).toBe("protected path");
    expect(await why(join(agents, ".trash", "old", "x"), atlas, atlas)).toBe("protected path");
    expect(await why(join(scratch, "x"), atlas, atlas)).toBe("protected path");
    expect(await why(join(bed.papHome, "state.db"), atlas, atlas)).toBe("protected path");
  });

  it("asks for a protected name inside its own home", async () => {
    expect(await why(".git/config", atlas, atlas)).toBe("protected path");
  });

  it("gives the same verdicts through a symlinked spelling of pap's home", async () => {
    const through = join(alias, "agents", "atlas-1a2b");
    expect(await why("MEMORY.md", through, through)).toBe("auto");
    expect(await why("MEMORY.md", atlas, through)).toBe("auto");
    expect(await why("MEMORY.md", through, atlas)).toBe("auto");
    expect(await why(join(alias, "agents", "scout-0000", "MEMORY.md"), through, through)).toBe(
      "protected path",
    );
    expect(await why(".git/config", through, through)).toBe("protected path");
  });

  it("asks for a file of the home with several hard links", async () => {
    await hardLink(join(bed.papHome, "state.db"), join(atlas, "hl.md"));
    expect(await why("hl.md", atlas, atlas)).toBe("protected path");
  });

  it("asks for a symlink of the home that leads to another agent", async () => {
    await symlink(join(scout, "MEMORY.md"), join(atlas, "peek.md"));
    expect(await why("peek.md", atlas, atlas)).toBe("protected path");
  });
});

describe("a session whose rules name nothing owns nothing in an agent home (RT-12)", () => {
  it("asks for MEMORY.md in a plain session opened in the home", async () => {
    expect(await why("MEMORY.md", atlas, null)).toBe("protected path");
  });

  it("asks when the rules name another agent's home", async () => {
    expect(await why("MEMORY.md", atlas, scout)).toBe("protected path");
  });
});

describe("an isolated task writes its scratch folder only (owner m17)", () => {
  it("writes there unasked", async () => {
    expect(await why("out.txt", scratch, scratch)).toBe("auto");
    expect(await why(join(scratch, "sub", "out.txt"), scratch, scratch)).toBe("auto");
  });

  it("asks for the agent home and another task's scratch folder", async () => {
    expect(await why(join(atlas, "MEMORY.md"), scratch, scratch)).toBe("protected path");
    expect(await why(join(agents, ".runs", "atlas-1a2b", OTHER_TASK, "x"), scratch, scratch)).toBe(
      "protected path",
    );
  });
});

describe("only an agent folder is ever an own folder", () => {
  const rooted = (...parts: string[]) => join(bed.papHome, ...parts);
  it.each([
    ["agents itself", () => rooted("agents")],
    ["the trash", () => rooted("agents", ".trash", "old")],
    ["the runs folder", () => rooted("agents", ".runs")],
    ["an agent's runs folder without a task", () => rooted("agents", ".runs", "atlas-1a2b")],
    ["a task id that is not one", () => rooted("agents", ".runs", "atlas-1a2b", "not-a-task")],
    ["an id that is not an agent id", () => rooted("agents", "Not_An_Agent")],
    ["a folder inside a home", () => rooted("agents", "atlas-1a2b", "sub")],
    ["pap's home", () => bed.papHome],
    ["a lane", () => rooted("worktrees", "fix-a-1a2b")],
    ["a folder outside pap's home", () => join(bed.base, "proj")],
    ["a spelling with a dot-dot segment", () => `${atlas}/../scout-0000`],
    ["a spelling with a dot segment", () => `${atlas}/.`],
  ])("names no own folder for %s", async (_name, folder) => {
    expect(await ownFolder(bed.cwd, bed.papHome, folder())).toEqual([]);
  });

  it("names none when the folder is a symlink to another agent folder or to the outside", async () => {
    await symlink(scout, join(agents, "evil-1111"), "dir");
    await symlink(bed.outside, join(agents, "evil-2222"), "dir");
    expect(await ownFolder(bed.cwd, bed.papHome, join(agents, "evil-1111"))).toEqual([]);
    expect(await ownFolder(bed.cwd, bed.papHome, join(agents, "evil-2222"))).toEqual([]);
  });

  it("names none when a symlink sits on the way", async () => {
    await symlink(agents, join(bed.base, "agents-link"), "dir");
    expect(await ownFolder(bed.cwd, bed.papHome, join(bed.base, "agents-link", "atlas-1a2b"))).toEqual([]);
  });

  it("names none when the spelling ends like an agent folder but sits under another folder", async () => {
    await mkdir(join(bed.base, "fake", "agents"), { recursive: true });
    await symlink(atlas, join(bed.base, "fake", "agents", "atlas-1a2b"), "dir");
    expect(await ownFolder(bed.cwd, bed.papHome, join(bed.base, "fake", "agents", "atlas-1a2b"))).toEqual([]);
  });

  it("does not let a symlinked home hand out the target's files (an edit stays a question)", async () => {
    await symlink(bed.outside, join(agents, "evil-2222"), "dir");
    const home = join(agents, "evil-2222");
    expect(await why("authorized_keys", home, home)).toBe("protected path");
  });

  it("names the home and the scratch folder in both spellings of pap's home", async () => {
    expect(await ownFolder(atlas, bed.papHome, atlas)).toEqual([atlas]);
    expect(await ownFolder(scratch, bed.papHome, scratch)).toEqual([scratch]);
    expect(await ownFolder(atlas, alias, join(alias, "agents", "atlas-1a2b"))).toEqual([
      join(alias, "agents", "atlas-1a2b"),
      atlas,
    ]);
  });
});
