import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentsRoot,
  makeHome,
  makeScratch,
  MAX_WALK_DEPTH,
  openScratch,
  removeScratch,
  removeTree,
  scratchPathOf,
  sweepScratch,
} from "./homes.ts";

const AGENT = "atlas-1a2b";
const TASK = "0b1c2d3e-0001-4000-8000-000000000001";
const OTHER_TASK = "0b1c2d3e-0002-4000-8000-000000000002";

let dir: string;
let papHome: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-scratch-"));
  papHome = join(dir, "pap");
  mkdirSync(papHome, { mode: 0o700 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const modeOf = (path: string): number => statSync(path).mode & 0o777;
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : String(error);
  }
  return undefined;
};
const runs = (): string => join(realpathSync(papHome), "agents", ".runs");

describe("makeScratch (M11R180)", () => {
  it("makes agents/.runs/<agent>/<task> beside the home, every level 0700", () => {
    const home = makeHome(papHome, AGENT);
    const scratch = makeScratch(papHome, AGENT, TASK);
    expect(scratch).toBe(join(runs(), AGENT, TASK));
    expect(scratch.startsWith(`${home}/`)).toBe(false);
    for (const level of [runs(), join(runs(), AGENT), scratch]) expect(modeOf(level)).toBe(0o700);
    expect(readdirSync(scratch)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it("names the same path without making anything", () => {
    expect(scratchPathOf(papHome, AGENT, TASK)).toBe(join(runs(), AGENT, TASK));
    expect(existsSync(runs())).toBe(false);
  });

  it("refuses an existing folder (conflict) and leaves what is in it", () => {
    const scratch = makeScratch(papHome, AGENT, TASK);
    writeFileSync(join(scratch, "out.txt"), "kept");
    expect(code(() => makeScratch(papHome, AGENT, TASK))).toBe("conflict");
    expect(readdirSync(scratch)).toEqual(["out.txt"]);
  });

  it("refuses a task id or an agent id of another shape", () => {
    expect(code(() => makeScratch(papHome, AGENT, "../escape"))).toBe("bad_request");
    expect(code(() => makeScratch(papHome, AGENT, "task-1"))).toBe("bad_request");
    expect(code(() => makeScratch(papHome, "../atlas", TASK))).toBe("bad_request");
    expect(existsSync(runs())).toBe(false);
  });

  it("refuses a linked .runs/<agent> level, and writes nothing through it", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(runs(), { recursive: true, mode: 0o700 });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(runs(), AGENT));
    expect(code(() => makeScratch(papHome, AGENT, TASK))).toBe("internal");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("openScratch: a task started again reuses its folder", () => {
  it("makes the folder the first time and says it was reused the second time", () => {
    const first = openScratch(papHome, AGENT, TASK);
    expect(first).toEqual({ path: join(runs(), AGENT, TASK), reused: false });
    writeFileSync(join(first.path, "out.txt"), "from the first attempt");
    expect(openScratch(papHome, AGENT, TASK)).toEqual({ path: first.path, reused: true });
    expect(readdirSync(first.path)).toEqual(["out.txt"]);
  });

  it("refuses a task folder that is a link", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    makeScratch(papHome, AGENT, OTHER_TASK);
    symlinkSync(elsewhere, join(runs(), AGENT, TASK));
    expect(code(() => openScratch(papHome, AGENT, TASK))).toBe("internal");
  });
});

describe("removeScratch", () => {
  it("removes the task's folder and nothing beside it", () => {
    const kept = makeScratch(papHome, AGENT, OTHER_TASK);
    const scratch = makeScratch(papHome, AGENT, TASK);
    writeFileSync(join(scratch, "out.txt"), "x");
    removeScratch(papHome, AGENT, TASK);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("removes a link inside, never what it points to", () => {
    const target = join(dir, "important");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep");
    const scratch = makeScratch(papHome, AGENT, TASK);
    symlinkSync(target, join(scratch, "link"));
    removeScratch(papHome, AGENT, TASK);
    expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(target)).toEqual(["keep.txt"]);
  });

  it("refuses a linked .runs/<agent> level and removes nothing through it", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(join(elsewhere, TASK), { recursive: true });
    writeFileSync(join(elsewhere, TASK, "keep.txt"), "keep");
    mkdirSync(runs(), { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, join(runs(), AGENT));
    expect(code(() => removeScratch(papHome, AGENT, TASK))).toBe("internal");
    expect(readdirSync(join(elsewhere, TASK))).toEqual(["keep.txt"]);
  });

  it("refuses a task id of another shape", () => {
    expect(code(() => removeScratch(papHome, AGENT, "../.."))).toBe("bad_request");
  });

  it("is quiet about a folder that is not there", () => {
    expect(code(() => removeScratch(papHome, AGENT, TASK))).toBeUndefined();
    expect(lstatSync(join(runs(), AGENT)).isDirectory()).toBe(true);
    expect(agentsRoot(papHome)).toBe(join(realpathSync(papHome), "agents"));
  });
});

describe("sweepScratch (I3: folders no task row and no session names)", () => {
  const THIRD = "0b1c2d3e-0003-4000-8000-000000000003";
  const none = () => false;

  it("removes the orphans and keeps the ones kept", () => {
    const kept = makeScratch(papHome, AGENT, TASK);
    const orphan = makeScratch(papHome, AGENT, OTHER_TASK);
    writeFileSync(join(orphan, "out.txt"), "x");
    const seen: string[] = [];
    const removed = sweepScratch(papHome, (agentId, taskId, path) => (seen.push(path), taskId === TASK), 10);
    expect(removed).toBe(1);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(seen.sort()).toEqual([kept, orphan].sort());
  });

  it("unlinks a link at the task level and never follows it", () => {
    const target = join(dir, "important");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep");
    makeScratch(papHome, AGENT, TASK);
    symlinkSync(target, join(runs(), AGENT, THIRD));
    expect(sweepScratch(papHome, (_a, taskId) => taskId === TASK, 10)).toBe(1);
    expect(existsSync(join(runs(), AGENT, THIRD))).toBe(false);
    expect(readdirSync(target)).toEqual(["keep.txt"]);
  });

  it("unlinks a link at the agent level and leaves its target", () => {
    const target = join(dir, "important");
    mkdirSync(join(target, TASK), { recursive: true });
    mkdirSync(runs(), { recursive: true, mode: 0o700 });
    symlinkSync(target, join(runs(), AGENT));
    expect(sweepScratch(papHome, none, 10)).toBe(1);
    expect(existsSync(join(runs(), AGENT))).toBe(false);
    expect(existsSync(join(target, TASK))).toBe(true);
  });

  it("ignores names of another shape and plain files", () => {
    makeScratch(papHome, AGENT, TASK);
    mkdirSync(join(runs(), AGENT, "notes"));
    writeFileSync(join(runs(), AGENT, "readme"), "x");
    mkdirSync(join(runs(), "not an agent"));
    expect(sweepScratch(papHome, none, 10)).toBe(1);
    expect(readdirSync(join(runs(), AGENT)).sort()).toEqual(["notes", "readme"]);
    expect(existsSync(join(runs(), "not an agent"))).toBe(true);
  });

  it("removes at most `limit` folders a pass, and makes nothing when there is no .runs", () => {
    expect(sweepScratch(papHome, none, 10)).toBe(0);
    expect(existsSync(runs())).toBe(false);
    makeScratch(papHome, AGENT, TASK);
    makeScratch(papHome, AGENT, OTHER_TASK);
    makeScratch(papHome, AGENT, THIRD);
    expect(sweepScratch(papHome, none, 2)).toBe(2);
    expect(readdirSync(join(runs(), AGENT))).toHaveLength(1);
  });
});

describe("a folder the task's own shell made unremovable (round 2)", () => {
  const hostile = (scratch: string): void => {
    mkdirSync(join(scratch, "a", "b"), { recursive: true });
    writeFileSync(join(scratch, "a", "b", "f.txt"), "x");
    mkdirSync(join(scratch, "locked"));
    writeFileSync(join(scratch, "locked", "f.txt"), "x");
    chmodSync(join(scratch, "a", "b"), 0o500);
    chmodSync(join(scratch, "locked"), 0o000);
  };
  const THIRD = "0b1c2d3e-0003-4000-8000-000000000003";

  it("removeScratch removes 0500 and 0000 subfolders", () => {
    const scratch = makeScratch(papHome, AGENT, TASK);
    hostile(scratch);
    removeScratch(papHome, AGENT, TASK);
    expect(existsSync(scratch)).toBe(false);
  });

  it("the sweep removes an orphan holding them", () => {
    const scratch = makeScratch(papHome, AGENT, TASK);
    hostile(scratch);
    expect(sweepScratch(papHome, () => false, 10)).toBe(1);
    expect(existsSync(scratch)).toBe(false);
  });

  it("does not follow a link while it opens permissions, and leaves its target alone", () => {
    const target = join(dir, "outside");
    mkdirSync(target);
    chmodSync(target, 0o500);
    const scratch = makeScratch(papHome, AGENT, TASK);
    symlinkSync(target, join(scratch, "out"));
    removeScratch(papHome, AGENT, TASK);
    expect(statSync(target).mode & 0o777).toBe(0o500);
    chmodSync(target, 0o700);
  });

  describe("a subdirectory swapped for a link while the walk runs (review I1)", () => {
    // The seam swaps `root/sub` for a link to a folder outside, when the walk reaches `at` of `where`.
    const swap = (at: "opened" | "listed", where: "root" | "sub") => {
      const root = join(dir, "root");
      const outside = join(dir, "outside");
      mkdirSync(join(root, "sub", "deep"), { recursive: true });
      mkdirSync(join(outside, "deep"), { recursive: true });
      chmodSync(join(outside, "deep"), 0o500);
      chmodSync(outside, 0o500);
      let swapped = false;
      removeTree(root, {
        hook: (stage, folder) => {
          if (stage !== at || folder !== (where === "root" ? root : join(root, "sub")) || swapped) return;
          swapped = true;
          renameSync(join(root, "sub"), join(root, "moved"));
          symlinkSync(outside, join(root, "sub"));
        },
      });
      expect(swapped).toBe(true);
      const modes = [statSync(outside).mode & 0o777, statSync(join(outside, "deep")).mode & 0o777];
      chmodSync(join(outside, "deep"), 0o700);
      chmodSync(outside, 0o700);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(join(outside, "deep"))).toBe(true);
      return modes;
    };

    it("never changes the folder a swapped parent points at (the children are opened under the held parent)", () => {
      expect(swap("opened", "sub")).toEqual([0o500, 0o500]);
    });

    it("nor one swapped after the listing of its parent", () => {
      expect(swap("listed", "root")).toEqual([0o500, 0o500]);
    });
  });

  describe("a tree deeper than the walk goes (round 2)", () => {
    it.skipIf(process.getuid?.() === 0)(
      "stops at the bound, tells it once, and leaves the failing removal to the caller",
      () => {
        const root = join(dir, "deep");
        mkdirSync(join(root, "a", "b", "c", "d"), { recursive: true });
        writeFileSync(join(root, "a", "b", "c", "d", "f.txt"), "x");
        chmodSync(join(root, "a", "b", "c", "d"), 0o500);
        const told: string[] = [];
        expect(() => removeTree(root, { maxDepth: 2, issue: ({ code }) => told.push(code) })).toThrow(
          /EACCES/,
        );
        expect(told).toEqual(["too_deep"]);
        expect(existsSync(root)).toBe(true);
        chmodSync(join(root, "a", "b", "c", "d"), 0o700);
        removeTree(root, { maxDepth: 4, issue: ({ code }) => told.push(code) });
        expect(told).toEqual(["too_deep"]);
        expect(existsSync(root)).toBe(false);
      },
    );

    it("walks 256 levels by default", () => {
      expect(MAX_WALK_DEPTH).toBe(256);
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "a removal that really fails throws its code, and the sweep tells it and goes on",
    () => {
      const scratch = makeScratch(papHome, AGENT, TASK);
      writeFileSync(join(scratch, "f.txt"), "x");
      const parent = join(runs(), AGENT);
      chmodSync(parent, 0o500);
      try {
        expect(() => removeScratch(papHome, AGENT, TASK)).toThrow(/EACCES/);
        const told: Array<{ code: string; name: string }> = [];
        expect(
          sweepScratch(
            papHome,
            () => false,
            10,
            (info) => told.push(info),
          ),
        ).toBe(0);
        expect(told).toEqual([{ code: "EACCES", name: TASK }]);
        expect(existsSync(scratch)).toBe(true);
      } finally {
        chmodSync(parent, 0o700);
      }
      expect(sweepScratch(papHome, () => false, 10)).toBe(1);
    },
  );

  it("one entry that fails does not stop the pass: the others go, the failure is told with a code and the folder name", () => {
    makeScratch(papHome, AGENT, TASK);
    makeScratch(papHome, AGENT, OTHER_TASK);
    makeScratch(papHome, AGENT, THIRD);
    const told: Array<{ code: string; name: string }> = [];
    const keep = (_a: string, taskId: string): boolean => {
      if (taskId === TASK) throw Object.assign(new Error("EACCES: /secret/path"), { code: "EACCES" });
      return false;
    };
    expect(sweepScratch(papHome, keep, 10, (info) => told.push(info))).toBe(2);
    expect(readdirSync(join(runs(), AGENT))).toEqual([TASK]);
    expect(told).toEqual([{ code: "EACCES", name: TASK }]);
  });

  it("refuses a linked agents folder, like every other entry point, and removes nothing through it", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(join(elsewhere, ".runs", AGENT, TASK), { recursive: true });
    symlinkSync(elsewhere, join(papHome, "agents"));
    expect(code(() => sweepScratch(papHome, () => false, 10))).toBe("internal");
    expect(existsSync(join(elsewhere, ".runs", AGENT, TASK))).toBe(true);
  });
});
