import net from "node:net";
import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SLOT } from "../../testing/guest-harness.ts";
import { b64, bed, cleanups, daemonEnd, memory, settle } from "./tunnels.rig.ts";

// Mutants, each killed by the case named:
//  - a `ping` parsed as a tunnel frame                    -> "a tunnel open for 60 s answers four pings and stays up"
//  - an ended tunnel kept in the map                      -> "10 000 tunnels opened and closed leave 0 entries"
//  - no send window                                       -> "stops reading the service past 1 MiB ..."
//  - `tunnel_end` before the data                         -> "stops reading the service past 1 MiB ..."
//  - the service socket never paused                      -> "stops reading the service past 1 MiB ..."
//  - an ack beyond what was sent accepted                 -> "an ack beyond what was sent ends the tunnel"
//  - the refusal carries the error                        -> "a refused open tells the daemon one fixed sentence ..."
//  - no cap on open tunnels                               -> "the 65th tunnel is refused"

describe("the guest's tunnels under failure", () => {
  it("a service that resets while the side connection is pending raises nothing uncaught and leaves no entry", async () => {
    let giveSide: (socket: net.Socket) => void = () => undefined;
    const service = memory();
    const t = bed({
      services: { connectTo: () => Promise.resolve(service.socket) },
      side: () =>
        new Promise((resolve) => {
          giveSide = resolve;
        }),
    });
    t.host.open({ slot: SLOT, service: "svc" });
    await settle();
    const uncaught: unknown[] = [];
    const record = (error: unknown): void => void uncaught.push(error);
    process.on("uncaughtException", record);
    cleanups.push(() => void process.off("uncaughtException", record));
    // `memory()` listens for errors itself: remove that listener so only the host's one stands between us and a crash.
    service.duplex.off("error", service.duplex.listeners("error")[0] as () => void);
    service.duplex.destroy(new Error("ECONNRESET"));
    await vi.waitFor(() => expect(t.host.size()).toBe(0));
    await settle();
    expect(uncaught).toEqual([]);
    expect(t.logs.join("\n")).toContain("service socket error: Error");
    expect(t.logs.join("\n")).not.toContain("ECONNRESET");
    giveSide(memory().socket);
  });

  it("does not acknowledge bytes the service did not take", async () => {
    const broken = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done(new Error("EPIPE"));
      },
    });
    broken.on("error", () => undefined);
    const t = bed({ services: { connectTo: () => Promise.resolve(broken as unknown as net.Socket) } });
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.sides).toHaveLength(1));
    const daemon = daemonEnd(t.sides[0] as ReturnType<typeof memory>);
    daemon.send({ type: "tunnel_data", data: b64("lost") });
    // The failed write closes the service: its tunnel_end goes out, and no ack for the bytes it never took.
    await vi.waitFor(() => expect(daemon.frames().some((frame) => frame.type === "tunnel_end")).toBe(true));
    expect(daemon.frames().some((frame) => frame.type === "tunnel_ack")).toBe(false);
  });

  it("a side connection that is already closed when it arrives leaves no entry", async () => {
    const t = bed({
      side: () => {
        const side = memory();
        side.duplex.destroy();
        return Promise.resolve(side.socket);
      },
    });
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.services[0]?.duplex.destroyed).toBe(true));
    expect(t.host.size()).toBe(0);
  });

  it("a side connection that fails closes the service and keeps no entry", async () => {
    const t = bed({ side: () => Promise.reject(new Error("connect timed out")) });
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.services[0]?.duplex.destroyed).toBe(true));
    expect(t.host.size()).toBe(0);
    expect(t.refused).toEqual([]);
  });
});
