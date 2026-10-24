import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectView, VcsStatus } from "@pap/contracts";
import { writeScript } from "./security/testing/agent-bed.ts";
import { rows } from "./security/testing/automation-bed.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import type { TestClient } from "./testing/ws-client.ts";

// The journeys of boxes lot B1 on the process backend: the real guest and the real pi-host worker as local processes, the
// scripted model, everything asked over RPC like the web does. What a person sees: answers, stream events, Inbox items, rows.

const write = (path: string, content: string, id: string) => ({
  toolCalls: [{ name: "write", args: { path, content }, id }],
});

let bed: BoxBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const phaseOf = async (b: BoxBed, projectId: string): Promise<string> =>
  (await b.call<{ box: { phase: string } }>("projects.box", { projectId })).box.phase;

/** The next `status` event of a vcs subscription that satisfies `ok`. */
async function vcsStatus(
  sub: string,
  ok: (status: VcsStatus) => boolean,
  client: TestClient,
): Promise<VcsStatus> {
  const frame = await client.waitForEvent((f) => {
    const event = f.event as { status?: VcsStatus | null };
    return f.sub === sub && event.status != null && ok(event.status);
  }, 30_000);
  return (frame.event as { status: VcsStatus }).status;
}

describe("a project in a box, end to end", () => {
  it("create a project, a session edits a file, Files reads it, Changes shows the diff, search finds the prompt", async () => {
    bed = await startBoxBed({ steps: [] });
    const project = await bed.createProject("Plans");
    expect(project).toMatchObject({ kind: "box" });
    const root = project.root;
    writeScript(bed.t, {
      steps: [write(`${root}/notes.md`, "# Plan\nship the box\n", "w1"), { text: "done" }],
    });

    // Files on a stopped box: asked, never started.
    const stopped = await bed.owner.client.call("files.list", { path: root });
    expect(stopped.ok ? "ok" : stopped.error.code).toBe("box_stopped");
    expect(await phaseOf(bed, project.id)).toBe("stopped");

    const sessionId = await bed.openSession(root);
    await bed.prompt(sessionId, "please record the plan in notes.md");
    expect(await phaseOf(bed, project.id)).toBe("running");

    const listing = await bed.call<{ entries: Array<{ name: string }> }>("files.list", { path: root });
    expect(listing.entries.map((entry) => entry.name)).toContain("notes.md");
    const read = await bed.call<{ text: string }>("files.read", { path: `${root}/notes.md` });
    expect(read.text).toBe("# Plan\nship the box\n");

    // Changes: the guest's git (it ran `git init` when the box was seeded) sees the new file, and the diff reads its worktree side.
    const watcher = await bed.t.connect(bed.owner.cookie);
    try {
      const opened = await watcher.call("subscribe.vcs", { root });
      expect(opened.ok).toBe(true);
      const sub = (opened as { result: { sub: string } }).result.sub;
      const status = await vcsStatus(sub, (s) => s.files.length > 0, watcher);
      expect(status).toMatchObject({ repo: true, root });
      expect(status.files.map((file) => file.path)).toContain("notes.md");
      const diff = await bed.call<{ after: string | null }>("vcs.fileDiff", {
        root,
        path: "notes.md",
        from: { kind: "head" },
        to: { kind: "worktree" },
      });
      expect(diff.after).toBe("# Plan\nship the box\n");
    } finally {
      watcher.close();
    }

    // The session's file is mirrored on this machine (the box's disk is not) and the scanner indexes the mirror.
    await vi.waitFor(
      async () => {
        const found = await bed?.call<{ hits: Array<{ sessionId: string }> }>("search.query", {
          q: "record",
        });
        expect(found?.hits.map((hit) => hit.sessionId)).toContain(sessionId);
      },
      { timeout: 20_000, interval: 250 },
    );
  }, 180_000);

  it("a trigger task runs in the project box", async () => {
    bed = await startBoxBed({ steps: [] });
    const project = await bed.createProject("Reports");
    const root = project.root;
    writeScript(bed.t, {
      steps: [write(`${root}/report.txt`, "all green\n", "w1"), { text: "report written" }],
    });
    const { triggerId, taskId } = await bed.fireTask(root);
    await vi.waitFor(() => expect(bed?.taskState(taskId)).toBe("done"), { timeout: 60_000, interval: 250 });

    // The task's session lives in the project, in its box; the box runs because the task started it.
    const session = rows<{ id: string; cwd: string }>(
      bed.t.home,
      "SELECT s.id, s.cwd FROM sessions s JOIN tasks t ON t.session_id = s.id WHERE t.id = ?",
      taskId,
    )[0];
    expect(session?.cwd).toBe(root);
    expect(
      rows<{ project_id: string }>(
        bed.t.home,
        "SELECT project_id FROM sessions WHERE id = ?",
        session?.id ?? "",
      ),
    ).toEqual([{ project_id: project.id }]);
    expect(await phaseOf(bed, project.id)).toBe("running");
    const read = await bed.call<{ text: string }>("files.read", { path: `${root}/report.txt` });
    expect(read.text).toBe("all green\n");
    expect(rows<{ id: string }>(bed.t.home, "SELECT id FROM triggers WHERE id = ?", triggerId)).toHaveLength(
      1,
    );
  }, 180_000);

  it("Scratch is created once and runs a session", async () => {
    bed = await startBoxBed({ steps: [] });
    const first = await bed.call<{ project: ProjectView }>("projects.scratch", {});
    const second = await bed.call<{ project: ProjectView }>("projects.scratch", {});
    expect(first.project).toMatchObject({ kind: "box", scratch: true, name: "Scratch" });
    expect(second.project.id).toBe(first.project.id);
    expect(
      rows<{ n: number }>(bed.t.home, "SELECT count(*) AS n FROM project_boxes WHERE scratch = 1")[0]?.n,
    ).toBe(1);

    const root = first.project.root;
    writeScript(bed.t, { steps: [write(`${root}/scratch.txt`, "quick\n", "w1"), { text: "ok" }] });
    const sessionId = await bed.openSession(root);
    await bed.prompt(sessionId, "jot a note");
    const read = await bed.call<{ text: string }>("files.read", { path: `${root}/scratch.txt` });
    expect(read.text).toBe("quick\n");

    // Scratch with a session is not deleted.
    const refused = await bed.owner.client.call("projects.delete", { projectId: first.project.id });
    expect(refused.ok ? "ok" : refused.error.code).toBe("conflict");
  }, 180_000);
});
