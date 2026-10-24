import { afterEach, describe, expect, it } from "vitest";
import type { ProjectView, VcsStatus } from "@pap/contracts";
import { type KataBed, LONG_MS, skipKata, startKataBed } from "../../testing/kata-bed.ts";

/*
 * Boxes lot B1 (spec boxes), the real stack: a project's box is a Kata microVM with its own disk. A project is made, its box
 * starts (the guest seeds the folders and runs `git init`), a session writes a file through Pi's write tool inside the box, and
 * the guest's git sees it. Skips with one warning without /dev/kvm or pap-vmd; fails under CI=1. Run in J3, in the root window.
 */
const skip = skipKata();
let bed: KataBed | undefined;
let projectId: string | undefined;
afterEach(async (context) => {
  if (context.task.result?.state === "fail") process.stderr.write(`${bed?.problems().join("\n")}\n`);
  if (bed && projectId) {
    // The box and its disk are the test's: stopped and deleted for good, not kept in pap-vmd's trash for a week.
    const box = { kind: "project", id: projectId } as const;
    await bed.vmd.request({ op: "vm.stop", box, taskKey: null }).catch(() => undefined);
    await bed.vmd.request({ op: "disk.delete", box, taskKey: null, purge: true }).catch(() => undefined);
  }
  await bed?.stop();
  bed = undefined;
  projectId = undefined;
});

describe.skipIf(skip)("a project's box on the real stack", () => {
  it(
    "create a project box, git init ran, a session writes a file, git.status sees it",
    async () => {
      bed = await startKataBed({ probe: false });
      const { project } = await bed.call<{ project: ProjectView }>("projects.create", { name: "Kata box" });
      projectId = project.id;
      const root = project.root;
      expect(root).toBe(`/boxes/${project.id}/project`);

      // A first start builds the box's image (minutes); the guest seeds the folders and runs `git init` once.
      await bed.call("projects.startBox", { projectId: project.id });
      const started = await bed.call<{ box: { phase: string } }>("projects.box", { projectId: project.id });
      expect(started.box.phase).toBe("running");
      const watcher = await bed.t.connect(bed.owner.cookie);
      try {
        const opened = await watcher.call("subscribe.vcs", { root });
        expect(opened.ok).toBe(true);
        const subscription = (opened as { result: { sub: string } }).result.sub;
        const statusWhere = async (ok: (status: VcsStatus) => boolean): Promise<VcsStatus> => {
          const frame = await watcher.waitForEvent((f) => {
            const event = f.event as { status?: VcsStatus | null };
            return f.sub === subscription && event.status != null && ok(event.status);
          }, 60_000);
          return (frame.event as { status: VcsStatus }).status;
        };
        const empty = await statusWhere((status) => status.repo);
        expect(empty).toMatchObject({ repo: true, branch: "main", files: [] });

        // A session writes a file with Pi's write tool; the model is the scripted one behind the relay.
        const { sessionId } = await bed.call<{ sessionId: string }>("sessions.create", { cwd: root });
        const { sub: sessionSub } = await bed.call<{ sub: string }>("subscribe.session", { sessionId });
        bed.llm.push(
          { tool: "write", args: { path: `${root}/hello.txt`, content: "hi\n" } },
          { text: "done" },
        );
        const client = bed.owner.client;
        const mark = client.events.filter((f) => f.sub === sessionSub).at(-1)?.seq ?? -1;
        const status = (name: string) => (f: { sub: string; event: unknown; seq: number }) =>
          f.sub === sessionSub && (f.event as { status?: string }).status === name && f.seq > mark;
        await bed.call("sessions.prompt", { sessionId, text: "write hello.txt" });
        const running = await client.waitForEvent(status("running"), LONG_MS);
        await client.waitForEvent((f) => status("idle")(f) && f.seq > running.seq, LONG_MS);

        await bed.call("vcs.refresh", { root });
        const changed = await statusWhere((s) => s.files.some((file) => file.path === "hello.txt"));
        expect(changed.files.map((file) => file.path)).toEqual(["hello.txt"]);
        const read = await bed.call<{ text: string }>("files.read", { path: `${root}/hello.txt` });
        expect(read.text).toBe("hi\n");
      } finally {
        watcher.close();
      }
    },
    LONG_MS,
  );
});
