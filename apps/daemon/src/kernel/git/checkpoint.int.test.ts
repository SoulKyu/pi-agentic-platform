import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaneBed, type LaneBed } from "../testing/lane-bed.ts";
import {
  captureCheckpoint,
  checkpointRef,
  deleteLaneRefs,
  entryIdsOf,
  laneRefs,
  restoreCheckpoint,
} from "./checkpoint.ts";

let lanes: LaneBed;
beforeEach(() => {
  lanes = createLaneBed();
});
afterEach(() => lanes.dispose());

const LANE_ID = "demo-0a1b";
const read = (path: string, name: string): string => readFileSync(join(path, name), "utf8");

async function capture(path: string, gitDir: string, key: Parameters<typeof checkpointRef>[1]) {
  const ref = checkpointRef(LANE_ID, key);
  const made = await captureCheckpoint(lanes.git, path, gitDir, lanes.indexDir, ref);
  await lanes.git.run(path, ["update-ref", "--no-deref", ref, made.commit], { gitDir });
  return made;
}

/** What Task 15 does: capture `undo` under the lane lock, then restore with it. */
async function restore(path: string, gitDir: string, commit: string) {
  const undo = await capture(path, gitDir, "undo");
  const result = await restoreCheckpoint(lanes.git, path, gitDir, commit, undo);
  return { undo, ...result };
}

describe("captureCheckpoint (M9R53)", () => {
  it("makes a commit authored by pap, with the lane's HEAD as its parent and the ref as its message", async () => {
    const { path, gitDir } = await lanes.lane("cap");
    writeFileSync(join(path, "a.txt"), "changed\n");
    const made = await capture(path, gitDir, { entryId: "abc123" });
    expect(lanes.bed.git(path, "log", "-1", "--format=%an <%ae>|%cn|%P|%s", made.commit).trim()).toBe(
      `pap <pap@users.noreply.invalid>|pap|${lanes.bed.git(path, "rev-parse", "HEAD").trim()}|pap checkpoint ${LANE_ID}/e/abc123`,
    );
    expect(lanes.bed.git(path, "rev-parse", `refs/pap/checkpoints/${LANE_ID}/e/abc123`).trim()).toBe(
      made.commit,
    );
    expect(lanes.bed.git(path, "rev-parse", "HEAD").trim()).toBe(
      lanes.bed.git(lanes.bed.root, "rev-parse", "pi/cap").trim(),
    );
    expect(lanes.bed.git(path, "show", `${made.commit}:a.txt`)).toBe("changed\n");
  });

  it("never moves a branch or HEAD, and leaves no staged change", async () => {
    const { path, gitDir } = await lanes.lane("still");
    const head = lanes.bed.git(path, "rev-parse", "HEAD");
    writeFileSync(join(path, "new.txt"), "n\n");
    await capture(path, gitDir, "root");
    expect(lanes.bed.git(path, "rev-parse", "HEAD")).toBe(head);
    expect(lanes.bed.git(path, "status", "--porcelain")).toBe("?? new.txt\n");
  });

  it("signs nothing, whatever the repository asks for", async () => {
    const { path, gitDir } = await lanes.lane("sign");
    lanes.bed.git(lanes.bed.root, "config", "commit.gpgsign", "true");
    const made = await capture(path, gitDir, "root");
    expect(lanes.bed.git(path, "cat-file", "-p", made.commit)).not.toContain("gpgsig");
  });
});

describe("restoreCheckpoint (M9R55)", () => {
  it("returns the files to the checkpoint, removes what came after, keeps ignored files, stages nothing", async () => {
    const { path, gitDir } = await lanes.lane("res");
    writeFileSync(join(path, ".gitignore"), ".env\n");
    lanes.bed.git(path, "add", ".gitignore");
    lanes.bed.git(path, "commit", "-q", "-m", "ignore");
    writeFileSync(join(path, "a.txt"), "at checkpoint\n");
    writeFileSync(join(path, "keep.txt"), "kept\n");
    const made = await capture(path, gitDir, { entryId: "e1" });
    writeFileSync(join(path, "a.txt"), "edited later\n");
    rmSync(join(path, "keep.txt"));
    writeFileSync(join(path, "after.txt"), "later\n");
    mkdirSync(join(path, "newdir"));
    writeFileSync(join(path, "newdir", "f.txt"), "f\n");
    writeFileSync(join(path, ".env"), "SECRET=1\n");

    await restore(path, gitDir, made.commit);
    expect(read(path, "a.txt")).toBe("at checkpoint\n");
    expect(read(path, "keep.txt")).toBe("kept\n");
    expect(existsSync(join(path, "after.txt"))).toBe(false);
    expect(existsSync(join(path, "newdir"))).toBe(false);
    expect(read(path, ".env")).toBe("SECRET=1\n");
    expect(lanes.bed.git(path, "diff", "--cached", "--name-only")).toBe("");
    expect(lanes.bed.git(path, "status", "--porcelain")).toBe(" M a.txt\n?? keep.txt\n");
  });

  it("restores an empty-tree checkpoint (every tracked file goes) and recreates a removed worktree root", async () => {
    const { path, gitDir } = await lanes.lane("empty");
    const empty = lanes.bed.git(path, "hash-object", "-t", "tree", "/dev/null").trim();
    const commit = lanes.bed.git(path, "commit-tree", empty, "-m", "empty").trim();
    await restore(path, gitDir, commit);
    expect(existsSync(join(path, "a.txt"))).toBe(false);
    expect(existsSync(join(path, "-rf"))).toBe(false);

    const made = await capture(path, gitDir, "undo");
    rmSync(path, { recursive: true, force: true });
    await restoreCheckpoint(lanes.git, path, gitDir, made.commit, { commit: made.commit, left: [] });
    expect(existsSync(path)).toBe(true);
  });

  it("never touches a file outside the worktree through a symlink that took the place of a folder", async () => {
    const { path, gitDir } = await lanes.lane("escape");
    mkdirSync(join(path, "dir"));
    writeFileSync(join(path, "dir", "inside.txt"), "inside\n");
    const made = await capture(path, gitDir, "root");
    const outside = join(lanes.bed.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "inside.txt"), "outside\n");
    writeFileSync(join(outside, "extra.txt"), "extra\n");
    rmSync(join(path, "dir"), { recursive: true });
    symlinkSync(outside, join(path, "dir"));
    await restore(path, gitDir, made.commit);
    expect(read(outside, "inside.txt")).toBe("outside\n");
    expect(read(outside, "extra.txt")).toBe("extra\n");
  });

  it("refuses a worktree root that is a symlink", async () => {
    const { path, gitDir } = await lanes.lane("rootlink");
    const made = await capture(path, gitDir, "root");
    const elsewhere = join(lanes.bed.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "k\n");
    rmSync(path, { recursive: true, force: true });
    symlinkSync(elsewhere, path);
    await expect(
      restoreCheckpoint(lanes.git, path, gitDir, made.commit, { commit: made.commit, left: [] }),
    ).rejects.toMatchObject({
      kind: "failed",
    });
    expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true);
  });
});

describe("lane refs (M9R53)", () => {
  it("lists e/…, root and undo, then deletes them all and nothing else", async () => {
    const { path, gitDir } = await lanes.lane("refs");
    const first = await capture(path, gitDir, { entryId: "e1" });
    await capture(path, gitDir, "root");
    await capture(path, gitDir, "undo");
    const otherRef = checkpointRef("other-0000", "root");
    await lanes.git.run(path, ["update-ref", "--no-deref", otherRef, first.commit], { gitDir });

    const refs = await laneRefs(lanes.git, path, gitDir, LANE_ID);
    expect([...refs.keys()].sort()).toEqual([
      `refs/pap/checkpoints/${LANE_ID}/e/e1`,
      `refs/pap/checkpoints/${LANE_ID}/root`,
      `refs/pap/checkpoints/${LANE_ID}/undo`,
    ]);
    expect(refs.get(`refs/pap/checkpoints/${LANE_ID}/e/e1`)).toBe(first.commit);
    expect(entryIdsOf(refs, LANE_ID)).toEqual(new Set(["e1", "root"]));

    await deleteLaneRefs(lanes.git, path, gitDir, LANE_ID);
    expect((await laneRefs(lanes.git, path, gitDir, LANE_ID)).size).toBe(0);
    expect((await laneRefs(lanes.git, path, gitDir, "other-0000")).size).toBe(1);
  });
});

describe("a planted clean filter never runs (MC13)", () => {
  it("not during capture or restore", async () => {
    const { path, gitDir } = await lanes.lane("filter");
    const { script, marker } = lanes.bed.plant("checkpoint-filter");
    writeFileSync(join(path, ".gitattributes"), "*.txt filter=evil\n");
    lanes.bed.git(path, "add", ".gitattributes");
    lanes.bed.git(path, "commit", "-q", "-m", "attributes");
    for (const kind of ["clean", "smudge"])
      lanes.bed.git(lanes.bed.root, "config", `filter.evil.${kind}`, script);
    writeFileSync(join(path, "a.txt"), "changed\n");
    writeFileSync(join(path, "b.txt"), "new\n");
    const made = await capture(path, gitDir, { entryId: "f1" });
    expect(existsSync(marker), "capture").toBe(false);
    writeFileSync(join(path, "a.txt"), "again\n");
    await restore(path, gitDir, made.commit);
    expect(existsSync(marker), "restore").toBe(false);
  });
});
