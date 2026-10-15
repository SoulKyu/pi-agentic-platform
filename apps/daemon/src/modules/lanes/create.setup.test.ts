import { deriveLaneStatus, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CreateBed, createCreateBed } from "./testing/create-bed.ts";

let bed: CreateBed | undefined;
afterEach(async () => {
  await bed?.service.shutdown();
  bed?.dispose();
  bed = undefined;
});
const make = (): CreateBed => (bed = createCreateBed());

const SETUP = "echo ready > ready.txt";
const idle = { busy: false, needsInput: false };
const withSetup = async (b: CreateBed, extra = ""): Promise<void> => {
  b.writeConfig(`setup: ${SETUP}\n${extra}`);
  await b.approve({ setup: SETUP, archive: undefined, test: undefined });
};
const statusOf = (b: CreateBed, id: string) => deriveLaneStatus(b.view(id), idle);

describe("lanes.create: the setup and the primary session", () => {
  it("runs the approved setup of a browser lane, and starts the session after its ok, with the first prompt", async () => {
    const b = make();
    await withSetup(b);
    b.behaviour.copyLog = ['skipped copy ".env": missing'];
    const id = await b.create({ title: "Add thing", description: "do it" });
    await vi.waitFor(() => expect(b.fakes.children).toHaveLength(1), { timeout: 5000 });
    expect(b.fakes.child(0).cwd).toBe(b.view(id).worktree);
    expect(b.view(id).setup.state).toBe("running");
    expect(b.order).not.toContain("session");
    b.fakes.child(0).emit("hello\n");
    b.fakes.child(0).end({ code: 0, signal: null });
    await b.service.settled();
    expect(b.view(id)).toMatchObject({
      state: "active",
      setup: { state: "ok", exitCode: 0 },
      primarySessionId: "sess-1",
    });
    expect(b.calls.sessions).toEqual([
      { caller: expect.objectContaining({ kind: "session" }), worktree: b.view(id).worktree, model: null },
    ]);
    expect(b.calls.prompts).toEqual([{ sessionId: "sess-1", text: "# Add thing\n\ndo it" }]);
    const log = b.runner.readLog("u1", id, "setup", 0).text;
    expect(log).toContain('skipped copy ".env": missing');
    expect(log).toContain("hello");
  });

  it("starts no session when the setup fails: needs attention, setup_failed", async () => {
    const b = make();
    await withSetup(b);
    const id = await b.create();
    await vi.waitFor(() => expect(b.fakes.children).toHaveLength(1), { timeout: 5000 });
    b.fakes.child(0).end({ code: 1, signal: null });
    await b.service.settled();
    expect(b.view(id)).toMatchObject({
      state: "active",
      setup: { state: "failed", exitCode: 1 },
      primarySessionId: null,
    });
    expect(b.order).not.toContain("session");
    expect(statusOf(b, id)).toEqual({ status: "needs_attention", reason: "setup_failed" });
  });

  it("starts the session without waiting when waitForSetup is false", async () => {
    const b = make();
    await withSetup(b, "waitForSetup: false\n");
    const id = await b.create();
    await vi.waitFor(() => expect(b.order).toContain("prompt"), { timeout: 5000 });
    expect(b.view(id).setup.state).toBe("running");
    expect(b.fakes.children).toHaveLength(1);
    b.fakes.child(0).end({ code: 0, signal: null });
    await b.service.settled();
  });

  it("keeps the setup of a token lane pending, spawns nothing and starts no session (waitForSetup)", async () => {
    const b = make();
    await withSetup(b);
    const id = await b.create({}, b.token());
    await b.service.settled();
    expect(b.view(id)).toMatchObject({
      state: "active",
      setup: { state: "pending" },
      primarySessionId: null,
    });
    expect(b.fakes.children).toHaveLength(0);
    expect(b.order).not.toContain("session");
    expect(statusOf(b, id)).toEqual({ status: "needs_attention", reason: "setup_pending" });
  });

  it("keeps a token lane's unapproved setup pending too, and starts its session when waitForSetup is false", async () => {
    const b = make();
    b.writeConfig(`setup: ${SETUP}\nwaitForSetup: false\n`);
    const id = await b.create({}, b.token());
    await b.service.settled();
    expect(b.view(id).setup.state).toBe("pending");
    expect(b.fakes.children).toHaveLength(0);
    expect(b.view(id).primarySessionId).toBe("sess-1");
  });

  it("starts the session of an unapproved setup, which is recorded unapproved and never run", async () => {
    const b = make();
    b.writeConfig(`setup: ${SETUP}\n`);
    const id = await b.create();
    await b.service.settled();
    expect(b.view(id)).toMatchObject({ setup: { state: "unapproved" }, primarySessionId: "sess-1" });
    expect(b.fakes.children).toHaveLength(0);
  });

  it("starts the session of a project with no setup", async () => {
    const b = make();
    const id = await b.create();
    await b.service.settled();
    expect(b.view(id)).toMatchObject({ setup: { state: "none" }, primarySessionId: "sess-1" });
    expect(b.order).toEqual(["reserve", "create", "copy", "ready", "session", "prompt"]);
  });

  it("opens the session with the lane's model and stores it", async () => {
    const b = make();
    const model = { provider: "anthropic", modelId: "claude", thinking: "high" as const };
    const id = await b.create({ models: [model] });
    await b.service.settled();
    expect(b.calls.sessions[0]?.model).toEqual(model);
    expect(b.view(id).model).toEqual(model);
  });

  it("notes a refused model and goes on with Pi's default", async () => {
    const b = make();
    b.behaviour.session = async () => ({ sessionId: "sess-9", modelRefused: true });
    const id = await b.create({ models: [{ provider: "p", modelId: "m" }] });
    await b.service.settled();
    expect(b.view(id).primarySessionId).toBe("sess-9");
    expect(b.view(id).notices).toEqual([{ kind: "model_refused", at: b.clock.now(), count: null }]);
  });

  it("leaves primary_session_id null when the session is refused with capacity: a log line and a notice", async () => {
    const b = make();
    b.behaviour.session = () => Promise.reject(new PapError("capacity"));
    const id = await b.create();
    await b.service.settled();
    expect(b.view(id)).toMatchObject({ state: "active", primarySessionId: null });
    expect(b.view(id).notices).toEqual([{ kind: "session_failed", at: b.clock.now(), count: null }]);
    expect(b.runner.readLog("u1", id, "setup", 0).text).toMatch(/session.*capacity/);
  });

  it("keeps the session and notes it when only the first prompt is refused", async () => {
    const b = make();
    b.behaviour.prompt = () => Promise.reject(new PapError("worker_failed")) as never;
    const id = await b.create();
    await b.service.settled();
    expect(b.view(id).primarySessionId).toBe("sess-1");
    expect(b.view(id).notices.map((notice) => notice.kind)).toEqual(["session_failed"]);
  });

  it("starts no session once the daemon stops, and shutdown does not wait for a setup that never ends", async () => {
    const b = make();
    await withSetup(b);
    const id = await b.create();
    await vi.waitFor(() => expect(b.fakes.children).toHaveLength(1), { timeout: 5000 });
    const stopping = Promise.all([b.runner.shutdown(), b.service.shutdown()]);
    b.fakes.child(0).end({ code: null, signal: "SIGTERM" });
    await stopping;
    expect(b.view(id).setup.state).toBe("interrupted");
    expect(b.order).not.toContain("session");
  });
});
