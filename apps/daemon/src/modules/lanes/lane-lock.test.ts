import { describe, expect, it } from "vitest";
import { createLaneLocks } from "./lane-lock.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const locks = () =>
  createLaneLocks((cwd) => (cwd.startsWith("/wt/a") ? "a" : cwd.startsWith("/wt/b") ? "b" : null));

describe("the lane lock", () => {
  it("never overlaps two runs on one lane and keeps their order", async () => {
    const { laneLock } = locks();
    const log: string[] = [];
    const first = deferred();
    const one = laneLock("a").run("commit", async () => {
      log.push("one:start");
      await first.promise;
      log.push("one:end");
    });
    const two = laneLock("a").run("archive", async () => {
      log.push("two:start");
    });
    const three = laneLock("a").run("checkpoint", async () => {
      log.push("three:start");
    });
    await flush();
    expect(log).toEqual(["one:start"]);
    first.resolve();
    await Promise.all([one, two, three]);
    expect(log).toEqual(["one:start", "one:end", "two:start", "three:start"]);
  });

  it("runs two lanes in parallel", async () => {
    const { laneLock } = locks();
    const gate = deferred();
    const started: string[] = [];
    const a = laneLock("a").run("commit", async () => {
      started.push("a");
      await gate.promise;
    });
    const b = laneLock("b").run("commit", async () => void started.push("b"));
    await b;
    expect(started).toEqual(["a", "b"]);
    gate.resolve();
    await a;
  });

  it("keeps the order after a run that throws, and hands the error to its caller only", async () => {
    const { laneLock } = locks();
    const failed = laneLock("a").run("commit", async () => {
      throw new Error("boom");
    });
    const after = laneLock("a").run("commit", async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });

  it("answers the promise of a running restore for the lane's folder, and null otherwise", async () => {
    const { laneLock, holdsFiles } = locks();
    expect(holdsFiles("/wt/a")).toBeNull();
    const gate = deferred();
    const restore = laneLock("a").run("restore", () => gate.promise);
    await flush();
    const held = holdsFiles("/wt/a/src");
    expect(held).toBeInstanceOf(Promise);
    expect(holdsFiles("/wt/b")).toBeNull();
    expect(holdsFiles("/elsewhere")).toBeNull();
    let released = false;
    void held?.then(() => (released = true));
    await flush();
    expect(released).toBe(false);
    gate.resolve();
    await restore;
    await held;
    expect(released).toBe(true);
    expect(holdsFiles("/wt/a")).toBeNull();
  });

  it("holds no files for a commit, an archive or a capture", async () => {
    const { laneLock, holdsFiles } = locks();
    const gate = deferred();
    const run = laneLock("a").run("commit", () => gate.promise);
    await flush();
    expect(holdsFiles("/wt/a")).toBeNull();
    gate.resolve();
    await run;
  });

  it("answers a failed restore's wait as ended, never as an error", async () => {
    const { laneLock, holdsFiles } = locks();
    const gate = deferred();
    const restore = laneLock("a").run("restore", async () => {
      await gate.promise;
      throw new Error("restore failed");
    });
    await flush();
    const held = holdsFiles("/wt/a") as Promise<void>;
    gate.resolve();
    await expect(restore).rejects.toThrow("restore failed");
    await expect(held).resolves.toBeUndefined();
  });
});
