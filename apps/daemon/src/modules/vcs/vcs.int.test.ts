import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VcsStatus } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

let t: TestDaemon | undefined;
let client: TestClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  await t?.stop();
  t = undefined;
});

const git = (cwd: string, home: string, ...args: string[]): void => {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
};

/** A repository in the harness's `work` folder with one commit, made a project root by a session. */
async function repository(): Promise<{ daemon: TestDaemon; c: TestClient }> {
  const daemon = await startTestDaemon({ steps: [{ text: "hi" }] });
  t = daemon;
  const home = join(daemon.root, "git-home");
  mkdirSync(home);
  git(daemon.cwd, home, "init", "-q", "-b", "main");
  writeFileSync(join(daemon.cwd, "a.txt"), "one\n");
  writeFileSync(join(daemon.cwd, "c.txt"), "keep\n");
  git(daemon.cwd, home, "add", ".");
  git(daemon.cwd, home, "commit", "-q", "-m", "init");
  const cookie = await daemon.login();
  const c = await daemon.connect(cookie);
  client = c;
  const created = (await c.call("sessions.create", { cwd: daemon.cwd })) as { ok: boolean };
  expect(created.ok).toBe(true);
  return { daemon, c };
}

describe("vcs over the socket", () => {
  it("streams a snapshot then the status of the repository, and diffs a file head to worktree", async () => {
    const { daemon, c } = await repository();
    const home = join(daemon.root, "git-home");
    writeFileSync(join(daemon.cwd, "a.txt"), "one\ntwo\n");
    writeFileSync(join(daemon.cwd, "b.txt"), "x\ny\n");
    git(daemon.cwd, home, "mv", "c.txt", "d.txt");

    const subscribed = (await c.call("subscribe.vcs", { root: daemon.cwd })) as {
      ok: boolean;
      result: { sub: string };
    };
    expect(subscribed.ok).toBe(true);
    const { sub } = subscribed.result;
    const snapshot = await c.waitForEvent((frame) => frame.sub === sub);
    expect(snapshot.event).toEqual({ kind: "snapshot", status: null });
    const update = await c.waitForEvent((frame) => frame.sub === sub && frame.seq > snapshot.seq, 20_000);
    const event = update.event as { kind: string; status: VcsStatus };
    expect(event.kind).toBe("status");
    expect(event.status).toMatchObject({
      root: daemon.cwd,
      repo: true,
      branch: "main",
      error: null,
      truncated: false,
    });
    expect(
      event.status.files.map((f) => [f.path, f.oldPath, f.kind, f.additions, f.deletions]).sort(),
    ).toEqual([
      ["a.txt", null, "modified", 1, 0],
      ["b.txt", null, "untracked", 2, 0],
      ["d.txt", "c.txt", "renamed", 0, 0],
    ]);
    expect([event.status.additions, event.status.deletions]).toEqual([3, 0]);

    const diff = (await c.call("vcs.fileDiff", {
      root: daemon.cwd,
      path: "a.txt",
      from: { kind: "head" },
      to: { kind: "worktree" },
    })) as { result: unknown };
    expect(diff.result).toEqual({ before: "one\n", after: "one\ntwo\n", binary: false, truncated: false });
    const refreshed = (await c.call("vcs.refresh", { root: daemon.cwd })) as { result: unknown };
    expect(refreshed.result).toEqual({ ok: true });
  });

  it("answers not_found for a subfolder and for the home folder", async () => {
    const { daemon, c } = await repository();
    mkdirSync(join(daemon.cwd, "sub"));
    for (const root of [join(daemon.cwd, "sub"), daemon.home]) {
      const reply = (await c.call("subscribe.vcs", { root })) as { ok: boolean; error: { code: string } };
      expect([reply.ok, reply.error.code], root).toEqual([false, "not_found"]);
    }
    const diff = (await c.call("vcs.fileDiff", {
      root: daemon.home,
      path: "state.db",
      from: { kind: "head" },
      to: { kind: "head" },
    })) as { error: { code: string } };
    expect(diff.error.code).toBe("not_found");
  });
});
