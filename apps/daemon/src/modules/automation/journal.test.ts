import { afterEach, describe, expect, it } from "vitest";
import { writeJournal } from "./fire-journal.ts";
import { createJournal } from "./journal.ts";
import { manualInput } from "./testing/bed.ts";
import { createRunnerBed, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

function setup() {
  bed = createRunnerBed();
  const journal = createJournal({ db: bed.db, triggers: bed.triggers, runs: bed.runs.port });
  return { journal, trigger: bed.trigger() };
}
const write = (triggerId: string, over: Partial<Parameters<typeof writeJournal>[1]> = {}): void =>
  writeJournal(bed.db, {
    triggerId,
    ownerId: "u1",
    source: "schedule",
    verdict: "precheck",
    detail: "exit 1",
    taskId: null,
    dedupKey: null,
    at: bed.clock.now(),
    ...over,
  });

describe("automation.journal (M10R65)", () => {
  it("collapses twelve identical precheck skips into one line with count 12 and its time range", async () => {
    const { journal, trigger } = setup();
    for (let skip = 0; skip < 12; skip += 1) {
      write(trigger.id);
      await bed.clock.advance(60_000);
    }
    const { entries, hasMore } = journal.page("u1", trigger.id, undefined);
    expect(hasMore).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      count: 12,
      source: "schedule",
      verdict: "precheck",
      detail: "exit 1",
      taskId: null,
      taskState: null,
      durationMs: null,
      costUsd: null,
    });
    expect((entries[0]?.at ?? 0) - (entries[0]?.firstAt ?? 0)).toBe(11 * 60_000);
  });

  it("starts a new line when the verdict, the source or the detail changes", () => {
    const { journal, trigger } = setup();
    write(trigger.id);
    write(trigger.id, { detail: "exit 2" });
    write(trigger.id, { detail: "exit 2", source: "manual" });
    write(trigger.id, { detail: "exit 2", source: "manual", verdict: "paused" });
    write(trigger.id, { detail: "exit 2", source: "manual", verdict: "paused" });
    const counts = journal.page("u1", trigger.id, undefined).entries.map((entry) => entry.count);
    expect(counts).toEqual([2, 1, 1, 1]);
  });

  it("never collapses fired lines: each has its own task", () => {
    const { journal, trigger } = setup();
    const ids = [1, 2, 3].map(
      () => bed.engine.fire(trigger.id, trigger.revision, fireInput()).taskId as string,
    );
    const { entries } = journal.page("u1", trigger.id, undefined);
    expect(entries.map((entry) => [entry.verdict, entry.count, entry.taskId])).toEqual(
      ids.reverse().map((id) => ["fired", 1, id]),
    );
  });

  it("returns pages of 50, newest first, with hasMore until the last", () => {
    const { journal, trigger } = setup();
    for (let line = 0; line < 120; line += 1) write(trigger.id, { verdict: "fired", detail: null });
    const first = journal.page("u1", trigger.id, undefined);
    expect(first.entries).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const ids = first.entries.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const second = journal.page("u1", trigger.id, ids.at(-1));
    expect(second.entries).toHaveLength(50);
    expect(second.hasMore).toBe(true);
    expect(Math.max(...second.entries.map((entry) => entry.id))).toBeLessThan(Math.min(...ids));
    const third = journal.page("u1", trigger.id, second.entries.at(-1)?.id);
    expect(third.entries).toHaveLength(20);
    expect(third.hasMore).toBe(false);
  });

  it("joins the task's state, its duration and its cost from the tasks and the runs", () => {
    const { journal, trigger } = setup();
    const taskId = bed.engine.fire(trigger.id, trigger.revision, fireInput()).taskId as string;
    const queued = journal.page("u1", trigger.id, undefined).entries[0];
    expect(queued).toMatchObject({ taskId, taskState: "queued", durationMs: null, costUsd: null });
    bed.db.run(
      "UPDATE tasks SET state = 'done', session_id = 's1', started_at = 1000, ended_at = 91000 WHERE id = $taskId",
      { taskId },
    );
    bed.runs.costs.set("s1", 0.42);
    const done = journal.page("u1", trigger.id, undefined).entries[0];
    expect(done).toMatchObject({ taskId, taskState: "done", durationMs: 90_000, costUsd: 0.42 });
  });

  it("keeps a line whose task row was removed, with no state", () => {
    const { journal, trigger } = setup();
    const taskId = bed.engine.fire(trigger.id, trigger.revision, fireInput()).taskId as string;
    bed.db.run("DELETE FROM tasks WHERE id = $taskId", { taskId });
    expect(journal.page("u1", trigger.id, undefined).entries[0]).toMatchObject({
      verdict: "fired",
      taskId,
      taskState: null,
    });
  });

  it("answers not_found for another owner's trigger and for an unknown one", () => {
    const { journal, trigger } = setup();
    expect(() => journal.page("u2", trigger.id, undefined)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => journal.page("u1", "nope", undefined)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  it("never shows another trigger's lines", () => {
    const { journal, trigger } = setup();
    const other = bed.trigger(manualInput(bed.folder, "Other"));
    write(other.id);
    expect(journal.page("u1", trigger.id, undefined).entries).toEqual([]);
  });
});
