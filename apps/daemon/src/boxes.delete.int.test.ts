import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeScript } from "./security/testing/agent-bed.ts";
import { rows } from "./security/testing/automation-bed.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";

let bed: BoxBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const count = (b: BoxBed, sql: string, ...params: string[]): number =>
  rows<{ n: number }>(b.t.home, sql, ...params)[0]?.n ?? -1;

describe("deleting a project in a box", () => {
  it("delete with a running session and task stops both, trashes disk and mirrors, removes rows and triggers", async () => {
    bed = await startBoxBed({ steps: [{ text: "hello" }] });
    const project = await bed.createProject("Doomed");
    const root = project.root;

    // A live session (its worker waits for the next prompt) in the box.
    const sessionId = await bed.openSession(root);
    await bed.prompt(sessionId, "hello there");
    const statusOf = async (id: string): Promise<string | undefined> =>
      (
        await bed?.call<{ sessions: Array<{ id: string; status: string }> }>("sessions.list", {})
      )?.sessions.find((entry) => entry.id === id)?.status;
    expect(await statusOf(sessionId)).toBe("idle");

    // A task that is still running: supervised, it asks before it writes, and nobody answers.
    writeScript(bed.t, {
      steps: [
        { toolCalls: [{ name: "write", args: { path: `${root}/late.txt`, content: "x" }, id: "w1" }] },
        { text: "never" },
      ],
    });
    const { taskId } = await bed.fireTask(root, { mode: "supervised" });
    await vi.waitFor(() => expect(bed?.taskState(taskId)).toBe("running"), {
      timeout: 60_000,
      interval: 250,
    });
    const taskSession = rows<{ session_id: string }>(
      bed.t.home,
      "SELECT session_id FROM tasks WHERE id = ?",
      taskId,
    )[0]?.session_id;
    expect(taskSession).toBeDefined();
    // The task row reads `running` once its session exists; the session itself reads `running` once the prompt has started.
    await vi.waitFor(async () => expect(await statusOf(taskSession ?? "")).toBe("running"), {
      timeout: 60_000,
      interval: 250,
    });

    // A pause told in the Inbox (the box crashed three times): the item carries the project.
    bed.vm.boxes.crashPause({ kind: "project", id: project.id }, () => {});
    expect(
      rows<{ ref_id: string }>(bed.t.home, "SELECT ref_id FROM inbox_items WHERE kind = 'box_paused'"),
    ).toEqual([{ ref_id: project.id }]);

    const mirrors = join(bed.t.home, "boxes", ".mirrors", project.id);
    expect(readdirSync(mirrors).length).toBeGreaterThan(0);
    expect(count(bed, "SELECT count(*) AS n FROM triggers WHERE project_id = ?", project.id)).toBe(1);

    const gone = await bed.call("projects.delete", { projectId: project.id });
    expect(gone).toEqual({ ok: true });

    // Both workers are stopped, the box is down, and nothing of the project is left in the database.
    expect(await statusOf(sessionId)).toBeUndefined();
    expect(await statusOf(taskSession ?? "")).toBeUndefined();
    expect(bed.vm.runtime.phase({ kind: "project", id: project.id })).toBe("stopped");
    expect(count(bed, "SELECT count(*) AS n FROM projects WHERE id = ?", project.id)).toBe(0);
    expect(count(bed, "SELECT count(*) AS n FROM project_boxes WHERE project_id = ?", project.id)).toBe(0);
    expect(
      count(bed, "SELECT count(*) AS n FROM sessions WHERE id IN (?, ?)", sessionId, taskSession ?? ""),
    ).toBe(0);
    expect(count(bed, "SELECT count(*) AS n FROM triggers WHERE project_id = ?", project.id)).toBe(0);
    expect(rows<{ state: string }>(bed.t.home, "SELECT state FROM tasks WHERE id = ?", taskId)).toEqual([
      { state: "cancelled" },
    ]);
    expect(count(bed, "SELECT count(*) AS n FROM inbox_items WHERE kind = 'box_paused'")).toBe(0);

    // The mirrors went to the host trash for seven days; the box's own disk is pap-vmd's (the process backend has none).
    expect(existsSync(mirrors)).toBe(false);
    const trashed = readdirSync(join(bed.t.home, "boxes", ".trash"));
    expect(trashed.filter((name) => name.startsWith(`${project.id}-`))).toHaveLength(1);
  }, 180_000);
});
