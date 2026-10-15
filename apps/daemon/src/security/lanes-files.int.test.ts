import { linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneView } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../kernel/db/database.ts";
import { type OutwardBed, startOutwardBed } from "../modules/lanes/testing/outward-bed.ts";
import { outcomeOf } from "./testing/fixtures.ts";
import { createLaneAs, type Ghost, latest, openStateDb, seedGhost, TIMEOUT } from "./testing/lanes-bed.ts";

// Spec C §8.1, M9 (M9R35): a lane's folder is a file root of its owner, and of nobody else; `$PAP_HOME` around it stays closed.
let bed: OutwardBed;
let db: Db;
let ghost: Ghost;
let own: LaneView;
beforeAll(async () => {
  bed = await startOutwardBed();
  db = openStateDb(bed);
  ghost = seedGhost(bed, db);
  // The lane index is read again after a create: the ghost's rows are in it from here on.
  const [id] = await createLaneAs(bed.owner, bed);
  await vi.waitFor(() => expect(latest(bed, id as string)?.state).toBe("active"), { timeout: TIMEOUT });
  own = latest(bed, id as string) as LaneView;
}, TIMEOUT);
afterAll(async () => {
  db?.close();
  await bed?.stop();
});

describe("security: the file roots of lanes", () => {
  it("lists and reads the owner's lane worktree", async () => {
    const listed = await bed.owner.call("files.list", { path: own.worktree });
    expect(listed).toMatchObject({
      ok: true,
      result: { entries: expect.arrayContaining([expect.objectContaining({ name: "a.txt" })]) },
    });
    const read = await bed.owner.call("files.read", { path: join(own.worktree, "a.txt") });
    expect(read).toMatchObject({ ok: true, result: { text: "one\n" } });
  });

  it("answers not_found for $PAP_HOME/worktrees itself, and for $PAP_HOME", async () => {
    for (const path of [join(bed.t.home, "worktrees"), bed.t.home]) {
      expect([path, outcomeOf(await bed.owner.call("files.list", { path }))]).toEqual([path, "not_found"]);
    }
  });

  it("answers not_found for another owner's lane folder and the file in it", async () => {
    expect(outcomeOf(await bed.owner.call("files.list", { path: ghost.worktree }))).toBe("not_found");
    expect(outcomeOf(await bed.owner.call("files.read", { path: join(ghost.worktree, "secret.txt") }))).toBe(
      "not_found",
    );
  });

  it("refuses a session whose folder is inside another owner's lane", async () => {
    const answer = await bed.owner.call("sessions.create", { cwd: ghost.worktree });
    expect(outcomeOf(answer)).toBe("forbidden");
  });

  it("refuses a hard link to pap's database made inside a worktree, by its inode", async () => {
    const control = join(own.worktree, "control.txt");
    writeFileSync(control, "plain\n");
    expect(outcomeOf(await bed.owner.call("files.read", { path: control }))).toBe("ok");
    const link = join(own.worktree, "db.bin");
    linkSync(join(bed.t.home, "state.db"), link);
    expect(outcomeOf(await bed.owner.call("files.read", { path: link }))).toBe("not_found");
  });
});
