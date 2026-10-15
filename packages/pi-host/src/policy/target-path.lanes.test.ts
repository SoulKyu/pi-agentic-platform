import { link as hardLink, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { checkEditTarget } from "./target-path.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
let laneA: string;
let laneB: string;
let worktrees: string;
let link: string;

beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
  await mkdir(join(bed.base, "home"), { recursive: true });
  worktrees = join(bed.papHome, "worktrees");
  laneA = join(worktrees, "fix-a-1a2b");
  laneB = join(worktrees, "fix-b-3c4d");
  await mkdir(join(laneA, "src"), { recursive: true });
  await mkdir(join(laneA, "sub"), { recursive: true });
  await mkdir(join(laneA, ".pi"), { recursive: true });
  await mkdir(laneB, { recursive: true });
  await mkdir(join(worktrees, "Not_A_Lane"), { recursive: true });
  await mkdir(join(bed.papHome, "secrets"), { recursive: true });
  await writeFile(join(bed.papHome, "state.db"), "x");
  await writeFile(join(laneA, ".git"), "gitdir: x");
  await symlink(join(bed.papHome, "secrets"), join(laneA, "secrets-link"), "dir");
  link = join(bed.base, "pap-link");
  await symlink(bed.papHome, link, "dir");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

const check = (path: unknown, from: string, withHome = true) =>
  checkEditTarget(path, from, [bed.agentDir, bed.papHome], withHome ? bed.papHome : undefined);
const why = async (path: unknown, from: string) => {
  const result = await check(path, from);
  return result.auto ? "auto" : result.review.why;
};

describe("a session in its own lane worktree edits it without asking (M9R44)", () => {
  it("allows a relative and an absolute path, and a subfolder session", async () => {
    expect(await why("src/x.ts", laneA)).toBe("auto");
    expect(await why(join(laneA, "src", "x.ts"), laneA)).toBe("auto");
    expect(await why("y.ts", join(laneA, "sub"))).toBe("auto");
  });

  it("allows the lane reached through a symlinked spelling of pap's home", async () => {
    expect(await why(join(link, "worktrees", "fix-a-1a2b", "src", "x.ts"), laneA)).toBe("auto");
  });

  it("allows a session whose folder is spelled through the symlinked home", async () => {
    expect(await why("src/x.ts", join(link, "worktrees", "fix-a-1a2b"))).toBe("auto");
  });

  it("allows the lane when pap's home itself is given through the symlink", async () => {
    const result = await checkEditTarget("src/x.ts", laneA, [bed.agentDir, bed.papHome], link);
    expect(result.auto).toBe(true);
  });
});

describe("everything else in pap's home stays protected", () => {
  it("asks for .git and .pi in the lane", async () => {
    expect(await why(".git", laneA)).toBe("protected path");
    expect(await why(".pi/project.yaml", laneA)).toBe("protected path");
  });

  it("asks for pap's state, and for a symlink out of the lane into it", async () => {
    expect(await why("../../state.db", laneA)).toBe("protected path");
    expect(await why("secrets-link/k", laneA)).toBe("protected path");
  });

  it("asks for a sibling lane, and for the lane's name written from the worktrees folder", async () => {
    expect(await why("../fix-b-3c4d/x", laneA)).toBe("protected path");
    expect(await why("fix-a-1a2b/x", worktrees)).toBe("protected path");
  });

  it("opens nothing for a folder not named like a lane", async () => {
    expect(await why("x", join(worktrees, "Not_A_Lane"))).toBe("protected path");
  });

  it("asks for a case-twisted spelling of the lane's protected names", async () => {
    expect(await why(".GIT/config", laneA)).toBe("protected path");
  });

  it("asks for Pi's agent folder", async () => {
    expect(await why(join(bed.agentDir, "models.json"), laneA)).toBe("protected path");
  });

  it("asks for a lane when the session is another lane's folder, even by absolute path", async () => {
    expect(await why(join(laneB, "x"), laneA)).toBe("protected path");
    expect(await why(join(laneA, "x"), laneB)).toBe("protected path");
  });
});

describe("before M9 and elsewhere", () => {
  it("asks for the lane's own file when no pap home is given", async () => {
    expect(await check("src/x.ts", laneA, false)).toMatchObject({
      auto: false,
      review: { why: "protected path", target: join(laneA, "src", "x.ts") },
    });
  });

  it("leaves an ordinary project folder alone", async () => {
    expect(await why("src/x.ts", bed.cwd)).toBe("auto");
  });
});

describe("a hard link inside the lane asks (M9 sweep, item 1)", () => {
  it("asks for a lane name that is a hard link to pap's state", async () => {
    await hardLink(join(bed.papHome, "state.db"), join(laneA, "hl"));
    expect(await check("hl", laneA)).toEqual({
      auto: false,
      review: { why: "protected path", target: join(laneA, "hl") },
    });
  });

  it("asks for a lane file that has a second hard link inside the lane (documented, fail-closed)", async () => {
    await writeFile(join(laneA, "src", "one.ts"), "x");
    await hardLink(join(laneA, "src", "one.ts"), join(laneA, "src", "two.ts"));
    expect(await why("src/one.ts", laneA)).toBe("protected path");
  });

  it("leaves a normal lane file and a file being created alone", async () => {
    await writeFile(join(laneA, "src", "plain.ts"), "x");
    expect(await why("src/plain.ts", laneA)).toBe("auto");
    expect(await why("src/new.ts", laneA)).toBe("auto");
  });
});
