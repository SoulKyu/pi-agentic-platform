import { describe, expect, it, vi } from "vitest";
import net from "node:net";
import { layout } from "../../testing/guest-harness.ts";
import { bed, FakeChild, op, port, start } from "../../testing/service-bed.ts";
describe("createServiceHost", () => {
  it("is running after the port is owned and a test connection succeeds", async () => {
    const b = bed();
    const answer = b.host.op(start("web"));
    (b.children[0] as FakeChild).listening = "own";
    b.ticks(1);
    const result = await answer;
    expect(result).toMatchObject({
      ok: true,
      value: { name: "web", port, state: "running", reason: null, startedAt: 0, network: true },
    });
    expect((result as { value: { id: string } }).value.id).toMatch(/^[0-9a-f]{32}$/);
    expect(b.inputs).toEqual([
      expect.objectContaining({ layout, network: true, command: "serve web", port }),
    ]);
    expect((b.inputs[0] as { proxy: Record<string, string> }).proxy.HTTP_PROXY).toBe(
      "http://10.213.0.1:7843",
    );
    expect(b.signals).toEqual([]);
  });

  it("stops the service at once on port_not_owned, with SIGTERM to the outer process only", async () => {
    const b = bed();
    const answer = b.host.op(start("web"));
    (b.children[0] as FakeChild).listening = "stranger";
    b.ticks(1);
    expect(await answer).toMatchObject({ ok: true, value: { state: "failed", reason: "port_not_owned" } });
    expect(b.signals).toEqual([[100, "SIGTERM"]]);
    expect(b.reports).toEqual([]);
  });

  it("fails port_timeout after 30 s, never before", async () => {
    const b = bed();
    let settled = false;
    const answer = b.host.op(start("web")).then((result) => ((settled = true), result));
    b.ticks(119);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(b.signals).toEqual([]);
    expect(b.clock.now()).toBe(29_750);
    b.ticks(1);
    expect(await answer).toMatchObject({ ok: true, value: { state: "failed", reason: "port_timeout" } });
    expect(b.signals).toEqual([[100, "SIGTERM"]]);
  });

  it("is exited when the child ends first, with its tail in svc.logs", async () => {
    const b = bed();
    const answer = b.host.op(start("web"));
    const child = b.children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("starting\nlisten"));
    child.stderr.emit("data", Buffer.from("Error: bad\n"));
    child.end(1);
    expect(await answer).toMatchObject({ ok: true, value: { state: "failed", reason: "exited" } });
    expect(await b.host.op(op("svc.logs", "web"))).toEqual({
      ok: true,
      value: { lines: ["starting", "Error: bad", "listen"] },
    });
    expect(b.reports).toEqual([]);
    expect(b.signals).toEqual([]);
  });

  it("is spawn_failed when the launcher throws, and logs the error class only", async () => {
    const b = bed();
    expect(await b.host.op(start("web", { command: "boom" }))).toMatchObject({
      ok: true,
      value: { state: "failed", reason: "spawn_failed" },
    });
    expect(b.logs.join("\n")).not.toContain("secret-detail");
    expect(b.logs.length).toBeGreaterThan(0);
  });

  async function running(b: ReturnType<typeof bed>, name: string, index: number): Promise<string> {
    const answer = b.host.op(start(name));
    (b.children[index] as FakeChild).listening = "own";
    b.ticks(1);
    return ((await answer) as { value: { id: string } }).value.id;
  }

  it("refuses a fifth service as conflict, and svc.list never holds more than 4", async () => {
    const b = bed();
    for (const [index, name] of ["a", "b", "c", "d"].entries()) await running(b, name, index);
    expect(await b.host.op(start("e"))).toEqual({ ok: false, code: "conflict" });
    expect(b.children).toHaveLength(4);
    const list = await b.host.op(op("svc.list"));
    expect((list as { value: { services: unknown[] } }).value.services).toHaveLength(4);
    // the second one ends by itself: a new name takes its place and the dead record is dropped, never a live one, never a fifth entry
    (b.children[1] as FakeChild).end(0);
    const answer = b.host.op(start("e"));
    (b.children[4] as FakeChild).listening = "own";
    b.ticks(1);
    await answer;
    const names = (
      (await b.host.op(op("svc.list"))) as { value: { services: Array<{ name: string }> } }
    ).value.services.map((service) => service.name);
    expect(names.sort()).toEqual(["a", "c", "d", "e"]);
  });

  it("restarts a running name with a new id when it is started again", async () => {
    const b = bed();
    const first = await running(b, "web", 0);
    const answer = b.host.op(start("web", { command: "serve v2" }));
    await vi.waitFor(() => expect(b.children).toHaveLength(2));
    expect(b.signals).toEqual([[100, "SIGTERM"]]);
    (b.children[1] as FakeChild).listening = "own";
    b.ticks(1);
    const result = (await answer) as { value: { id: string; state: string } };
    expect(result.value.state).toBe("running");
    expect(result.value.id).not.toBe(first);
    const list = (await b.host.op(op("svc.list"))) as { value: { services: unknown[] } };
    expect(list.value.services).toHaveLength(1);
    expect(b.reports).toEqual([]);
  });

  it("svc.restart re-runs the stored spec, not_found without one; svc.stop and svc.logs follow the name", async () => {
    const b = bed();
    expect(await b.host.op(op("svc.restart", "web"))).toEqual({ ok: false, code: "not_found" });
    expect(await b.host.op(op("svc.logs", "web"))).toEqual({ ok: false, code: "not_found" });
    expect(await b.host.op(op("svc.stop", "web"))).toEqual({ ok: true, value: { stopped: false } });
    await running(b, "web", 0);
    const again = b.host.op(op("svc.restart", "web"));
    await vi.waitFor(() => expect(b.children).toHaveLength(2));
    (b.children[1] as FakeChild).listening = "own";
    b.ticks(1);
    expect(await again).toMatchObject({ ok: true, value: { name: "web", state: "running" } });
    expect(b.inputs[1]).toMatchObject({ command: "serve web", port, network: true });
    expect(await b.host.op(op("svc.stop", "web"))).toEqual({ ok: true, value: { stopped: true } });
    expect(await b.host.op(op("svc.stop", "web"))).toEqual({ ok: true, value: { stopped: false } });
    const list = (await b.host.op(op("svc.list"))) as { value: { services: Array<{ state: string }> } };
    expect(list.value.services.map((service) => service.state)).toEqual(["stopped"]);
    expect(b.reports).toEqual([]);
  });

  it("reports an unasked exit once, and a stop reports nothing", async () => {
    const b = bed();
    const id = await running(b, "web", 0);
    (b.children[0] as FakeChild).end(3, null);
    (b.children[0] as FakeChild).end(4, null);
    expect(b.reports).toEqual([{ type: "service", id, state: "exited", code: 3, signal: null }]);
    const view = (await b.host.op(op("svc.list"))) as { value: { services: Array<{ state: string }> } };
    expect(view.value.services[0]?.state).toBe("exited");
    await running(b, "api", 1);
    await b.host.op(op("svc.stop", "api"));
    expect(b.reports).toHaveLength(1);
  });

  it("stops with SIGTERM to the outer process, SIGKILL to it after 2 s, never a pid of the tree", async () => {
    const b = bed();
    await running(b, "web", 0);
    (b.children[0] as FakeChild).dies = ["SIGKILL"];
    const stopped = b.host.op(op("svc.stop", "web"));
    expect(b.signals).toEqual([[100, "SIGTERM"]]);
    b.clock.advance(1999);
    expect(b.signals).toEqual([[100, "SIGTERM"]]);
    b.clock.advance(1);
    expect(b.signals).toEqual([
      [100, "SIGTERM"],
      [100, "SIGKILL"],
    ]);
    expect(await stopped).toEqual({ ok: true, value: { stopped: true } });
    expect(b.clock.pending()).toBe(0);
  });

  it("kills a service with its sandbox when the guest stops it, and sends no signal once its exit came", async () => {
    const b = bed();
    await running(b, "web", 0);
    await running(b, "api", 1);
    const starting = b.host.op(start("slow"));
    (b.children[1] as FakeChild).end(0);
    b.host.closeAll();
    expect(b.signals).toEqual([
      [100, "SIGKILL"],
      [120, "SIGKILL"],
    ]);
    b.host.closeAll();
    expect(b.signals).toHaveLength(2);
    expect(await starting).toMatchObject({ ok: true, value: { name: "slow" } });
    expect(b.reports).toEqual([expect.objectContaining({ state: "exited" })]);
    expect(b.clock.pending()).toBe(0);
  });

  it("answers the first start as stopped when the same name is started again while it waits", async () => {
    const b = bed();
    const first = b.host.op(start("web"));
    const second = b.host.op(start("web", { command: "serve v2" }));
    expect(await first).toMatchObject({ ok: true, value: { state: "stopped" } });
    await vi.waitFor(() => expect(b.children).toHaveLength(2));
    (b.children[1] as FakeChild).listening = "own";
    b.ticks(1);
    expect(await second).toMatchObject({ ok: true, value: { state: "running" } });
  });

  it("probes a service without network through the namespace helper, pinned to the pid and start time", async () => {
    const targets: Array<{ pid: number; start: string }> = [];
    let closed = 0;
    let refuse = true;
    const b = bed({
      nsDialer: (target) => {
        targets.push(target);
        if (refuse) return null;
        return {
          connect: () => Promise.resolve(net.connect(port, "127.0.0.1")),
          close: () => void closed++,
        };
      },
    });
    const answer = b.host.op(start("web", { network: false }));
    (b.children[0] as FakeChild).listening = "own";
    b.ticks(1);
    await vi.waitFor(() => expect(b.clock.pending()).toBe(1));
    expect(targets).toEqual([{ pid: 101, start: "101" }]);
    refuse = false;
    b.ticks(1);
    expect(await answer).toMatchObject({ ok: true, value: { state: "running", network: false } });
    await vi.waitFor(() => expect(closed).toBe(1));
  });

  it("connectTo checks ownership again and refuses a service that is not running", async () => {
    const b = bed();
    const id = await running(b, "web", 0);
    const socket = await b.host.connectTo(id);
    socket.destroy();
    await expect(b.host.connectTo("0".repeat(32))).rejects.toThrow("service is not running");
    (b.children[0] as FakeChild).listening = "stranger";
    await expect(b.host.connectTo(id)).rejects.toThrow("service port is not owned by the service");
    (b.children[0] as FakeChild).listening = "none";
    await expect(b.host.connectTo(id)).rejects.toThrow("service is not reachable");
  });
});
