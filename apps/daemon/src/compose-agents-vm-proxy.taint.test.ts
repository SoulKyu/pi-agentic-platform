import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeVmProxy } from "./compose-agents-vm-proxy.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { loopbackVmSeams } from "./modules/egress/testing/vm.ts";
import { captureLogger } from "./testing/capture-logger.ts";

const grant = {
  launchId: "l1",
  box: { kind: "agent", id: "atlas-1a2b" } as const,
  relayKey: "k",
  address: "127.0.0.1",
  taskKey: null,
};

/** One CONNECT to the listed host from 127.0.0.1 (the launch's address); resolves once the tunnel answers. */
const tunnel = (port: number, host: string): Promise<Socket> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    socket.once("data", () => resolve(socket));
    socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  });

describe("the VMs' proxy taints a launch's sessions (spec 4)", () => {
  const closers: Array<{ name: string; close(): void | Promise<void> }> = [];
  let echo: Server;
  let open: Socket[];
  let tainted: string[];
  let proxy: ReturnType<typeof composeVmProxy>;
  let lines: ReturnType<typeof captureLogger>["lines"];
  let port: number;

  beforeEach(async () => {
    open = [];
    tainted = [];
    echo = createServer((socket) => socket.on("error", () => {}).pipe(socket));
    const echoPort = await new Promise<number>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve((echo.address() as { port: number }).port)),
    );
    const captured = captureLogger();
    lines = captured.lines;
    proxy = composeVmProxy({
      clock: createFakeClock(),
      logger: captured.logger,
      bind: undefined,
      late: () => ({
        hostsOf: () => ["feed.example.test", "docs.example.test"],
        trustedOf: () => ["docs.example.test"],
      }),
      closers,
      seams: loopbackVmSeams({
        "feed.example.test": { 443: echoPort },
        "docs.example.test": { 443: echoPort },
      }),
    });
    proxy.bindTaint((sessionId) => void tainted.push(sessionId));
    port = await proxy.start();
    proxy.launched(grant);
  });
  afterEach(async () => {
    for (const socket of open) socket.destroy();
    for (const closer of closers.splice(0)) await closer.close();
    await new Promise((resolve) => echo.close(resolve));
  });
  const via = async (host: string) => void open.push(await tunnel(port, host));

  it("taints the sessions joined so far once, however many tunnels, and one that joins later starts tainted", async () => {
    proxy.join("l1", "s1");
    await via("feed.example.test");
    await via("feed.example.test");
    expect(tainted).toEqual(["s1"]);
    proxy.join("l1", "s2");
    expect(tainted).toEqual(["s1", "s2"]);
  });

  it("leaves a session that joins a launch no unclean tunnel reached clean, and a trusted source taints nothing", async () => {
    proxy.join("l1", "s1");
    await via("docs.example.test");
    proxy.join("l1", "s2");
    expect(tainted).toEqual([]);
  });

  it("forgets an ended launch: a session joining a new launch of the same id starts clean", async () => {
    proxy.join("l1", "s1");
    await via("feed.example.test");
    proxy.ended("l1");
    proxy.join("l1", "s3");
    expect(tainted).toEqual(["s1"]);
  });

  it("keeps tainting the rest when one session's taint throws, and logs it", async () => {
    proxy.bindTaint((sessionId) => {
      if (sessionId === "s1") throw new Error("gone");
      tainted.push(sessionId);
    });
    proxy.join("l1", "s1");
    proxy.join("l1", "s2");
    await via("feed.example.test");
    await vi.waitFor(() => expect(tainted).toEqual(["s2"]));
    expect(lines.some((line) => line.msg === "egress_vm_taint_failed")).toBe(true);
  });
});
