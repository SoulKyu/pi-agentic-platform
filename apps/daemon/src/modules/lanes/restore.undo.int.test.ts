import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CheckpointBed, readyLane, startCheckpointBed, TIMEOUT } from "./testing/checkpoint-int.ts";

let bed: CheckpointBed;
beforeEach(async () => {
  bed = await startCheckpointBed();
});
afterEach(() => bed.stop());

/** Every file of the folder outside `.git`, ignored ones included, by path. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    if (name === ".git") continue;
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(join(dir, path)).isDirectory()) Object.assign(out, snapshot(dir, path));
    else out[path] = readFileSync(join(dir, path), "utf8");
  }
  return out;
}

async function started() {
  const lane = await readyLane(bed);
  const sessionId = lane.primarySessionId as string;
  const restore = (params: object) =>
    bed.owner.call("lanes.restore", { laneId: lane.id, ...params } as never).then(
      (answer) =>
        (
          answer as unknown as {
            result: { ok: boolean; changed?: boolean; left?: Array<{ path: string; reason: string }> };
          }
        ).result,
    );
  return { lane, sessionId, toTurn: () => restore({ sessionId }), undo: () => restore({ undo: true }) };
}

describe("Undo is a swap that loses nothing (fix round 1, C2)", () => {
  it(
    "an ignored .env the restore left alone survives Restore, Undo and Undo of Undo",
    async () => {
      const { lane, toTurn, undo } = await started();
      const dir = lane.worktree;
      writeFileSync(join(dir, ".gitignore"), ".env\n");
      writeFileSync(join(dir, ".env"), "secret\n");
      writeFileSync(join(dir, "a.txt"), "hand\n");
      expect(await toTurn()).toMatchObject({ ok: true, changed: true });
      // The restore removed .gitignore and kept the ignored .env.
      expect(existsSync(join(dir, ".gitignore"))).toBe(false);
      expect(readFileSync(join(dir, ".env"), "utf8")).toBe("secret\n");
      const restored = snapshot(dir);

      const undone = await undo();
      expect(undone).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hand\n");
      // The .gitignore Undo brought back ignores .env again: it stays where it is, and is reported.
      expect(readFileSync(join(dir, ".env"), "utf8")).toBe("secret\n");
      expect(undone.left).toContainEqual({ path: ".env", reason: "ignored" });

      expect(await undo()).toMatchObject({ ok: true, changed: true });
      expect(snapshot(dir)).toEqual(restored);
    },
    TIMEOUT,
  );

  it(
    "a hand edit made between Restore and Undo survives Undo of Undo",
    async () => {
      const { lane, toTurn, undo } = await started();
      const dir = lane.worktree;
      writeFileSync(join(dir, "a.txt"), "before restore\n");
      expect(await toTurn()).toMatchObject({ ok: true, changed: true });
      writeFileSync(join(dir, "mine.txt"), "typed after the restore\n");
      const edited = snapshot(dir);
      expect(await undo()).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("before restore\n");
      // A file no ignore rule covers, captured by the swap, is removed by Undo and comes back with the second one.
      expect(existsSync(join(dir, "mine.txt"))).toBe(false);
      expect(await undo()).toMatchObject({ ok: true, changed: true });
      expect(snapshot(dir)).toEqual(edited);
    },
    TIMEOUT,
  );

  it(
    "Undo twice returns the exact tree, and so does every further pair",
    async () => {
      const { lane, toTurn, undo } = await started();
      const dir = lane.worktree;
      writeFileSync(join(dir, "a.txt"), "edited\n");
      writeFileSync(join(dir, "new.txt"), "new\n");
      const before = snapshot(dir);
      await toTurn();
      const restored = snapshot(dir);
      expect(restored).not.toEqual(before);
      for (let pair = 0; pair < 2; pair++) {
        await undo();
        expect(snapshot(dir)).toEqual(before);
        await undo();
        expect(snapshot(dir)).toEqual(restored);
      }
    },
    TIMEOUT,
  );
});
