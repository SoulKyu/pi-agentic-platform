import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeScript } from "./security/testing/agent-bed.ts";
import { rows } from "./security/testing/automation-bed.ts";
import { callsUnder } from "./testing/host-spy.ts";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import { httpRequest } from "./testing/http-client.ts";

// The daemon's own file helpers are recorded for the whole run (mocked below): a box project is not on this machine, so nothing
// of its life may reach them with a path at or under its root, even when the process backend makes that root a real folder here.
vi.mock("./kernel/fs/safe-open.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./kernel/fs/safe-open.ts")>();
  const { recorded } = await import("./testing/host-spy.ts");
  return {
    ...real,
    openRegularFile: recorded("openRegularFile", real.openRegularFile),
    openFolder: recorded("openFolder", real.openFolder),
    writeAtomic: recorded("writeAtomic", real.writeAtomic),
  };
});
vi.mock("./kernel/fs/boundary.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./kernel/fs/boundary.ts")>();
  const { recorded } = await import("./testing/host-spy.ts");
  return { ...real, judgePath: recorded("judgePath", real.judgePath) };
});
vi.mock("./kernel/git/runner.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./kernel/git/runner.ts")>();
  const { recorded } = await import("./testing/host-spy.ts");
  return {
    ...real,
    createGitRunner: (deps: Parameters<typeof real.createGitRunner>[0]) => {
      const runner = real.createGitRunner(deps);
      return { ...runner, run: recorded("git.run", runner.run.bind(runner)) };
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const { recorded } = await import("./testing/host-spy.ts");
  return { ...real, realpathSync: recorded("realpathSync", real.realpathSync) };
});

let bed: BoxBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const write = (path: string, content: string, id: string) => ({
  toolCalls: [{ name: "write", args: { path, content }, id }],
});

describe("the host never reads a box project", () => {
  it("the host never reads a box project: create, session, Files, Changes, knowledge, a trigger task and delete", async () => {
    bed = await startBoxBed({ steps: [] });
    const b = bed;
    const call = b.call;
    // Each request on its own connection: a skip answers before the body is read, and the server then closes that connection.
    const asOwner = {
      origin: b.t.origin,
      cookie: b.owner.cookie,
      "content-type": "application/octet-stream",
      connection: "close",
    };
    const rawUrl = (path: string, query: string): string =>
      `${b.t.base}/files/raw?path=${encodeURIComponent(path)}&${query}`;

    // The control: a host project's folder does reach the helpers, so the recording sees what it should.
    execFileSync("git", ["init", "-q"], { cwd: b.t.cwd });
    await call("projects.add", { root: b.t.cwd });
    await call("files.list", { path: b.t.cwd });
    const hostWatcher = await b.t.connect(b.owner.cookie);
    await hostWatcher.call("subscribe.vcs", { root: b.t.cwd });
    hostWatcher.close();
    await vi.waitFor(
      () => {
        const seen = new Set(callsUnder(b.t.cwd).map((line) => line.split(" ")[0]));
        for (const helper of ["realpathSync", "judgePath", "openFolder", "git.run"])
          expect(seen).toContain(helper);
      },
      { timeout: 10_000, interval: 100 },
    );

    const project = await b.createProject("Remote");
    const root = project.root;
    writeScript(b.t, { steps: [write(`${root}/notes.md`, "hello\n", "w1"), { text: "done" }] });
    const sessionId = await b.openSession(root);
    await b.prompt(sessionId, "write the notes");

    // Files: list, read, write, search, upload (a skip over an existing file stops at the first chunk), download.
    expect((await call<{ entries: unknown[] }>("files.list", { path: root })).entries.length).toBeGreaterThan(
      0,
    );
    const read = await call<{ meta: { etag: string }; text: string }>("files.read", {
      path: `${root}/notes.md`,
    });
    expect(read.text).toBe("hello\n");
    await call("files.write", { path: `${root}/notes.md`, text: "hello again\n", baseEtag: read.meta.etag });
    await call("files.write", { path: `${root}/second.txt`, text: "second\n", baseEtag: null });
    const found = await call<{ paths: string[] }>("files.search", { root, query: "second" });
    expect(found.paths).toContain("second.txt");
    const big = "x".repeat(3 * 1024 * 1024);
    const put = () =>
      httpRequest(rawUrl(`${root}/big.txt`, "conflict=skip"), {
        method: "PUT",
        headers: { ...asOwner, "content-length": String(Buffer.byteLength(big)) },
        body: big,
      });
    const created = await put();
    expect(created.status).toBe(200);
    expect(JSON.parse(created.body)).toMatchObject({ written: true });
    // The same name again with `skip`: the guest answers a skip on the first chunk, the rest of the body is not sent on.
    const skipped = await put();
    expect(skipped.status).toBe(200);
    expect(JSON.parse(skipped.body)).toEqual({ written: false });
    const downloaded = await httpRequest(rawUrl(`${root}/big.txt`, "download=1"), { headers: asOwner });
    expect(downloaded.status).toBe(200);
    expect(downloaded.body).toHaveLength(big.length);

    // Changes: a subscription, a refresh and a diff.
    const watcher = await b.t.connect(b.owner.cookie);
    try {
      const opened = await watcher.call("subscribe.vcs", { root });
      expect(opened.ok).toBe(true);
      await call("vcs.refresh", { root });
      const diff = await call<{ after: string | null }>("vcs.fileDiff", {
        root,
        path: "second.txt",
        from: { kind: "head" },
        to: { kind: "worktree" },
      });
      expect(diff.after).toBe("second\n");
    } finally {
      watcher.close();
    }

    // Knowledge: enable and read the state, both asked of the guest.
    await call("projects.enableKnowledge", { projectId: project.id });
    expect(await call("projects.knowledge", { projectId: project.id })).toMatchObject({ enabled: true });

    // A trigger task, in the same box.
    writeScript(b.t, { steps: [write(`${root}/report.txt`, "ok\n", "w2"), { text: "reported" }] });
    const { taskId } = await b.fireTask(root);
    await vi.waitFor(() => expect(b.taskState(taskId)).toBe("done"), { timeout: 60_000, interval: 250 });

    await call("projects.delete", { projectId: project.id });
    expect(
      rows<{ n: number }>(b.t.home, "SELECT count(*) AS n FROM projects WHERE id = ?", project.id),
    ).toEqual([{ n: 0 }]);

    // None of it reached the host's helpers with a path of the box.
    expect(callsUnder(root)).toEqual([]);
  }, 240_000);
});
