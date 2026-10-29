import type net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { bed, FakeChild, op, start } from "../../testing/service-bed.ts";

describe("createServiceHost guards", () => {
  it("starts nothing once the guest is closing, even a start that waited on a stop", async () => {
    const b = bed();
    const first = b.host.op(start("web"));
    (b.children[0] as FakeChild).listening = "own";
    b.ticks(1);
    await first;
    (b.children[0] as FakeChild).dies = ["SIGKILL"];
    const again = b.host.op(start("web", { command: "serve v2" }));
    expect(b.signals).toEqual([[100, "SIGTERM"]]);
    b.host.closeAll();
    expect(await again).toEqual({ ok: false, code: "failed" });
    expect(b.children).toHaveLength(1);
    expect(await b.host.op(start("api"))).toEqual({ ok: false, code: "failed" });
    expect(await b.host.op(op("svc.restart", "web"))).toEqual({ ok: false, code: "failed" });
    expect(b.children).toHaveLength(1);
    expect(await b.host.op(op("svc.list"))).toMatchObject({ ok: true });
    expect(b.clock.pending()).toBe(0);
  });

  it("fails a service whose readiness check throws, and logs the error class only", async () => {
    const b = bed({
      wrapProc: (proc) => ({
        ...proc,
        tcpTables: () => {
          throw new Error("secret-detail EACCES");
        },
      }),
    });
    const answer = b.host.op(start("web"));
    (b.children[0] as FakeChild).listening = "own";
    b.ticks(1);
    expect(await answer).toMatchObject({ ok: true, value: { state: "failed", reason: "port_timeout" } });
    expect(b.signals).toEqual([[100, "SIGTERM"]]);
    expect(b.logs.join("\n")).toContain("check failed");
    expect(b.logs.join("\n")).not.toContain("secret-detail");
  });

  it("stops waiting for a namespace helper after 2 s, closes it and destroys a socket that comes late", async () => {
    let closed = 0;
    let deliver: (socket: net.Socket) => void = () => undefined;
    const b = bed({
      nsDialer: () => ({
        connect: () => new Promise<net.Socket>((resolve) => (deliver = resolve)),
        close: () => void closed++,
      }),
    });
    const answer = b.host.op(start("web", { network: false }));
    (b.children[0] as FakeChild).listening = "own";
    b.ticks(1);
    await vi.waitFor(() => expect(b.clock.pending()).toBe(1));
    b.clock.advance(1999);
    expect(closed).toBe(0);
    b.clock.advance(1);
    await vi.waitFor(() => expect(closed).toBe(1));
    const late = { destroy: vi.fn() };
    deliver(late as unknown as net.Socket);
    await vi.waitFor(() => expect(late.destroy).toHaveBeenCalledTimes(1));
    b.host.closeAll();
    expect(await answer).toMatchObject({ ok: true, value: { name: "web" } });
  });

  it("keeps a partial line back until the pipes close, not the exit", async () => {
    const b = bed();
    const answer = b.host.op(start("web"));
    const child = b.children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from("last words"));
    child.emit("exit", 1, null);
    await answer;
    expect(await b.host.op(op("svc.logs", "web"))).toEqual({ ok: true, value: { lines: [] } });
    child.emit("close", 1, null);
    expect(await b.host.op(op("svc.logs", "web"))).toEqual({ ok: true, value: { lines: ["last words"] } });
  });
});
