import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CheckpointBed, readyLane, startCheckpointBed, TIMEOUT } from "./testing/checkpoint-int.ts";

let bed: CheckpointBed;
beforeEach(async () => {
  bed = await startCheckpointBed();
});
afterEach(() => bed.stop());

const ended = (): number => bed.captures().filter((line) => line.startsWith("end after")).length;
const result = (answer: { ok: boolean }) => (answer as unknown as { result: unknown }).result;

describe("lanes.checkpointStatus and lanes.restore over /ws, with real git and a scripted agent", () => {
  it(
    "three turns, back to turn 1's end: the files differ, restore brings turn 1's files, undo brings turn 3's back",
    async () => {
      const lane = await readyLane(bed);
      const sessionId = lane.primarySessionId as string;
      const file = join(lane.worktree, "a.txt");
      for (const turn of [2, 3]) {
        expect(await bed.prompt(sessionId, `turn ${turn}`)).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(ended()).toBe(turn), { timeout: 60_000 });
      }
      expect(readFileSync(file, "utf8")).toBe("v3\n");

      // The branch's rows give the entry that ended turn 1: the row before the second user message.
      const subscribed = await bed.owner.call("subscribe.session", { sessionId });
      const sub = (subscribed as unknown as { result: { sub: string } }).result.sub;
      const frame = await bed.owner.waitForEvent((f) => f.sub === sub);
      const rows = (frame.event as { rows: Array<{ entryId: string | null; message: { role?: string } }> })
        .rows;
      const secondUser = rows.findIndex(
        (row, at) =>
          row.message.role === "user" && at > 0 && rows.slice(0, at).some((r) => r.message.role === "user"),
      );
      const turnOneEnd = rows[secondUser - 1]?.entryId as string;
      expect(turnOneEnd).toBeTruthy();
      expect(await bed.owner.call("sessions.navigate", { sessionId, targetId: turnOneEnd })).toMatchObject({
        ok: true,
      });

      const status = () => bed.owner.call("lanes.checkpointStatus", { laneId: lane.id, sessionId });
      expect(result(await status())).toEqual({
        target: { entryId: turnOneEnd, turn: 1 },
        exact: true,
        differs: true,
        undoAvailable: false,
      });

      const restored = await bed.owner.call("lanes.restore", { laneId: lane.id, sessionId });
      expect(result(restored)).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(file, "utf8")).toBe("v1\n");
      expect(result(await status())).toMatchObject({ differs: false, undoAvailable: true });
      // The real index and HEAD were not touched by the restore.
      expect(bed.repo.git(lane.worktree, "diff", "--cached", "--name-only").trim()).toBe("");

      // A second restore to the same target changes nothing, and keeps the undo of the first.
      expect(result(await bed.owner.call("lanes.restore", { laneId: lane.id, sessionId }))).toEqual({
        ok: true,
        changed: false,
      });

      const undone = await bed.owner.call("lanes.restore", { laneId: lane.id, undo: true });
      expect(result(undone)).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(file, "utf8")).toBe("v3\n");
    },
    TIMEOUT,
  );
});
