import { tmpdir } from "node:os";
import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { FakeChild, type ForkState, ofType, useHelperBed } from "./testing/pool-bed.ts";

const state = vi.hoisted((): ForkState => ({ children: [], forkArgs: [] }));
vi.mock("node:child_process", () => ({
  fork: vi.fn((...args: unknown[]) => {
    state.forkArgs.push(args);
    const next = state.children.shift();
    if (next instanceof Error) throw next;
    return next;
  }),
}));

const bed = useHelperBed(state);
const { start } = bed;

describe("the spawn", () => {
  it("forks the helper entry in its own group, in tmpdir, with the worker's environment rules", () => {
    const { child } = start();
    const [entry, args, options] = state.forkArgs[0] as [string, string[], Record<string, unknown>];
    expect(entry).toBe("/helper/main.ts");
    expect(args).toEqual([]);
    expect(options).toMatchObject({
      cwd: tmpdir(),
      execArgv: ["--conditions=development"],
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    expect(options.env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      PI_CODING_AGENT_DIR: "/agent",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
    expect(child.sent[0]).toEqual({
      type: "helper_run",
      op: "ping",
      agentDir: "/agent",
      papHome: "/pap",
      params: { a: 1 },
    });
  });

  it("sends the project folder when the run is about one", () => {
    const child = new FakeChild();
    state.children.push(child);
    bed.pool.run("trust.get", {}, { deadlineMs: 1000, cwd: "/work/project" }).done.catch(() => {});
    expect(child.sent[0]).toMatchObject({ cwd: "/work/project" });
  });

  it("refuses a relative project folder, a bad deadline and a closed pool before forking", async () => {
    expect(() => bed.pool.run("x", {}, { deadlineMs: 1000, cwd: "relative" })).toThrow(PapError);
    expect(() => bed.pool.run("x", {}, { deadlineMs: 0 })).toThrow(PapError);
    expect(() => bed.pool.run("x", {}, { deadlineMs: Number.NaN })).toThrow(PapError);
    expect(state.forkArgs).toHaveLength(0);
    await bed.pool.stopAll();
    expect(() => bed.pool.run("x", {}, { deadlineMs: 1000 })).toThrow(
      expect.objectContaining({ code: "helper_failed" }),
    );
  });
});

describe("capacity", () => {
  it("refuses a fifth run at once while four are active, and counts again after one ends", async () => {
    const running = [start(), start(), start(), start()];
    expect(bed.pool.active()).toBe(4);
    expect(() => bed.pool.run("ping", {}, { deadlineMs: 1000 })).toThrow(
      expect.objectContaining({ code: "capacity" }),
    );
    expect(state.forkArgs).toHaveLength(4);
    running[0]?.child.end();
    await bed.clock.advance(0);
    expect(bed.pool.active()).toBe(3);
    start();
    expect(bed.pool.active()).toBe(4);
  });
});

describe("results", () => {
  it("resolves with the result of helper_done and frees the slot at the exit", async () => {
    const { child, handle } = start();
    child.deliver({ type: "helper_done", ok: true, result: { piVersion: "1" } });
    expect(await handle.done).toEqual({ piVersion: "1" });
    child.end();
    await bed.clock.advance(0);
    expect(bed.pool.active()).toBe(0);
    expect(bed.clock.pending()).toBe(0);
  });

  it("rejects with the mapped code of a failed op and bed.logs its detail, never sends it on", async () => {
    const { child, handle } = start();
    const rejected = handle.done.catch((error: PapError) => error);
    child.deliver({ type: "helper_done", ok: false, code: "not_found", detail: "no such provider" });
    expect(await rejected).toMatchObject({ code: "not_found", message: "Not found." });
    expect(bed.logs[0]).toMatchObject({
      msg: "helper_op_failed",
      fields: { code: "not_found", detail: "no such provider" },
    });
  });

  const failWithOutput = async (op: string) => {
    const child = new FakeChild();
    state.children.push(child);
    const handle = bed.pool.run(op, {}, { deadlineMs: 60_000 });
    const rejected = handle.done.catch((error: PapError) => error);
    child.stderr.emit("data", Buffer.from(`${"a".repeat(9000)}npm ERR! 404`));
    child.deliver({ type: "helper_done", ok: false, code: "failed", detail: "x" });
    await rejected;
    return bed.logs.find((entry) => entry.msg === "helper_op_failed")?.fields as { tail?: string };
  };

  it("logs the clipped output tail of a failed skills install, so it can be diagnosed (MC55, T24 M1)", async () => {
    const fields = await failWithOutput("skills.install");
    expect(fields.tail).toBe(`${"a".repeat(2048 - "npm ERR! 404".length)}npm ERR! 404`);
  });

  it.each(["models.provider.get", "models.provider.save", "models.provider.remove", "auth.setApiKey"])(
    "logs no output tail for a failed %s (the key flow's output stays out of the log)",
    async (op) => {
      expect(await failWithOutput(op)).not.toHaveProperty("tail");
    },
  );

  it("logs no output tail for a failed op of another kind (MC57)", async () => {
    const fields = await failWithOutput("models.pricing");
    expect(fields).not.toHaveProperty("tail");
  });

  it("maps a plain failure to helper_failed", async () => {
    const { child, handle } = start();
    const rejected = handle.done.catch((error: PapError) => error);
    child.deliver({ type: "helper_done", ok: false, code: "failed" });
    expect(await rejected).toMatchObject({ code: "helper_failed" });
  });

  it("keeps the first answer only", async () => {
    const { child, handle } = start();
    child.deliver({ type: "helper_done", ok: true, result: 1 });
    child.deliver({ type: "helper_done", ok: true, result: 2 });
    expect(await handle.done).toBe(1);
  });

  it("still delivers a record that arrives after the exit, before the streams are drained", async () => {
    const { child, handle } = start();
    child.emit("exit", 0, null);
    child.deliver({ type: "helper_done", ok: true, result: "late" });
    child.emit("close");
    expect(await handle.done).toBe("late");
  });

  const runAs = (op: string, deadlineMs = 60_000) => {
    const child = new FakeChild();
    state.children.push(child);
    const handle = bed.pool.run(op, {}, { deadlineMs });
    return { child, rejected: handle.done.catch((error: PapError) => error) };
  };
  const failedFields = () =>
    bed.logs.find((entry) => entry.msg === "helper_failed")?.fields as { tail?: string; why: string };

  it("rejects helper_failed when a skills install exits without answering, logging the clipped tail", async () => {
    const { child, rejected } = runAs("skills.install");
    child.stderr.emit("data", Buffer.from(`${"a".repeat(9000)}THE-END`));
    child.end(3);
    expect(await rejected).toMatchObject({ code: "helper_failed" });
    const fields = failedFields();
    expect(fields.why).toBe("exit");
    expect(fields.tail).toBe(`${"a".repeat(2048 - "THE-END".length)}THE-END`);
  });

  it("keeps an 8 KiB tail of stdout and stderr, whatever was printed", async () => {
    const { child, rejected } = runAs("skills.install");
    for (let i = 0; i < 50; i++) child.stdout.emit("data", Buffer.alloc(1024 * 1024, "x"));
    child.stdout.emit("data", Buffer.from("TAIL-MARK"));
    child.end(1);
    await rejected;
    expect(failedFields().tail?.endsWith("TAIL-MARK")).toBe(true);
  });

  it("logs no output tail when another op exits without answering (MC59)", async () => {
    const { child, rejected } = runAs("plugins.install");
    child.stderr.emit("data", Buffer.from("npm http fetch https://registry.example/secret-token"));
    child.end(3);
    await rejected;
    expect(failedFields().why).toBe("exit");
    expect(failedFields()).not.toHaveProperty("tail");
  });

  it("logs no output tail when another op times out (MC59)", async () => {
    const { child, rejected } = runAs("plugins.install", 500);
    child.stderr.emit("data", Buffer.from("npm http fetch https://registry.example/secret-token"));
    await bed.clock.advance(500);
    expect(await rejected).toMatchObject({ code: "timeout" });
    expect(failedFields().why).toBe("deadline");
    expect(failedFields()).not.toHaveProperty("tail");
  });

  it("logs no output tail when another op sends a malformed record (MC59)", async () => {
    const { child, rejected } = runAs("plugins.install");
    child.stderr.emit("data", Buffer.from("npm ERR! https://registry.example/secret-token"));
    child.deliver({ nonsense: true });
    await rejected;
    expect(failedFields()).not.toHaveProperty("tail");
  });
});

describe("the deadline and the kill ladder", () => {
  it("rejects timeout at the deadline, then climbs cancel, SIGTERM, SIGKILL on the group", async () => {
    const { child, handle } = start({ deadlineMs: 500 });
    const rejected = handle.done.catch((error: PapError) => error);
    await bed.clock.advance(499);
    expect(ofType(child, "helper_cancel")).toHaveLength(0);
    await bed.clock.advance(1);
    expect(await rejected).toMatchObject({ code: "timeout" });
    expect(ofType(child, "helper_cancel")).toHaveLength(1);
    expect(bed.signals()).toEqual([]);
    await bed.clock.advance(2000);
    expect(bed.signals()).toEqual([`-${child.pid}:SIGTERM`]);
    await bed.clock.advance(3000);
    expect(bed.signals()).toEqual([`-${child.pid}:SIGTERM`, `-${child.pid}:SIGKILL`]);
    expect(bed.pool.active()).toBe(1);
    child.end(null as unknown as number);
    await bed.clock.advance(0);
    expect(bed.pool.active()).toBe(0);
    expect(bed.clock.pending()).toBe(0);
  });

  it("does not time out an answer that arrived in time, and clears its timer", async () => {
    const { child, handle } = start({ deadlineMs: 500 });
    child.deliver({ type: "helper_done", ok: true, result: 7 });
    await bed.clock.advance(10_000);
    expect(await handle.done).toBe(7);
  });

  it("declares a helper that outlives SIGKILL gone after the last wait, freeing its slot", async () => {
    const { handle } = start({ deadlineMs: 100 });
    handle.done.catch(() => {});
    await bed.clock.advance(100 + 2000 + 3000 + 5000);
    expect(bed.pool.active()).toBe(0);
    expect(bed.logs.some((entry) => entry.msg === "helper_unkillable")).toBe(true);
  });

  it("cancel() sends helper_cancel, then kills after the grace", async () => {
    const { child, handle } = start();
    handle.cancel();
    expect(ofType(child, "helper_cancel")).toHaveLength(1);
    expect(bed.signals()).toEqual([]);
    await bed.clock.advance(2000);
    expect(bed.signals()).toEqual([`-${child.pid}:SIGTERM`]);
  });

  it("does not signal a group whose leader was reaped", async () => {
    const { child, handle } = start();
    handle.cancel();
    child.emit("exit", 0, null);
    bed.kill.mockClear();
    await bed.clock.advance(5000);
    expect(bed.signals().filter((entry) => entry.endsWith("SIGTERM"))).toEqual([]);
  });

  it("kills the leftover group when the leader exits", () => {
    const { child } = start();
    child.emit("exit", 0, null);
    expect(bed.signals()).toEqual([`-${child.pid}:SIGKILL`]);
  });
});

describe("stopAll", () => {
  it("cancels every running helper, waits for them, and fails their runs", async () => {
    const a = start();
    const b = start();
    const rejected = [a, b].map(({ handle }) => handle.done.catch((error: PapError) => error));
    let stopped = false;
    const stopping = bed.pool.stopAll().then(() => (stopped = true));
    expect(ofType(a.child, "helper_cancel")).toHaveLength(1);
    expect(ofType(b.child, "helper_cancel")).toHaveLength(1);
    await bed.clock.advance(0);
    expect(stopped).toBe(false);
    a.child.end();
    b.child.end();
    await stopping;
    expect(stopped).toBe(true);
    expect((await Promise.all(rejected)).map((error) => (error as PapError).code)).toEqual([
      "helper_failed",
      "helper_failed",
    ]);
    expect(bed.pool.active()).toBe(0);
  });

  it("is idempotent and resolves at once with nothing running", async () => {
    await bed.pool.stopAll();
    await bed.pool.stopAll();
  });
});
