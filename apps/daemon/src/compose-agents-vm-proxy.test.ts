import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { composeVmProxy } from "./compose-agents-vm-proxy.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { captureLogger } from "./testing/capture-logger.ts";

const grant = (launchId: string, taskKey: string | null) => ({
  launchId,
  agentId: "atlas-1a2b",
  relayKey: "k",
  address: "127.0.0.1",
  taskKey,
});

const refused = (port: number): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket: Socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    socket.write("CONNECT secret-host.example.test:443 HTTP/1.1\r\nHost: x\r\n\r\n");
  });

describe("the VMs' proxy composition", () => {
  const closers: Array<{ name: string; close(): void | Promise<void> }> = [];
  afterEach(async () => {
    for (const closer of closers.splice(0)) await closer.close();
  });

  it("judges a launch by its address, logs a refusal with the host labelled, and forgets an ended launch", async () => {
    const { logger, lines } = captureLogger();
    const proxy = composeVmProxy({
      clock: createFakeClock(),
      logger,
      bind: undefined,
      late: () => ({
        hostsOf: (agentId) => (agentId === "atlas-1a2b" ? ["listed.example.test"] : null),
        trustedOf: () => [],
      }),
      closers,
    });
    const port = await proxy.start();
    expect(closers.map((closer) => closer.name)).toEqual(["agent_vm_proxy"]);
    expect(await refused(port)).toMatch(/^HTTP\/1\.1 403/); // no launch behind the address yet
    expect(lines.filter((line) => line.msg === "egress_vm_refused")).toEqual([]);

    proxy.launched(grant("l1", null));
    const reply = await refused(port);
    expect(reply).toMatch(/secret-host\.example\.test:443 is not on this agent's host list \(not_listed\)/);
    const [line, ...rest] = lines.filter((entry) => entry.msg === "egress_vm_refused");
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ agentId: "atlas-1a2b", port: 443, reason: "not_listed" });
    expect(line?.host).toMatch(/^h:[0-9a-f]{12} \(len 24\)$/);

    proxy.ended("l1");
    expect(await refused(port)).toMatch(/^HTTP\/1\.1 403/);
    expect(lines.filter((entry) => entry.msg === "egress_vm_refused")).toHaveLength(1);
  });

  it("names a thread VM's source \"thread\" and a task VM's by its task key, and a bound sink replaces the log line", async () => {
    const { logger, lines } = captureLogger();
    const proxy = composeVmProxy({
      clock: createFakeClock(),
      logger,
      bind: undefined,
      late: () => ({ hostsOf: () => [], trustedOf: () => [] }),
      closers,
    });
    const sources: unknown[] = [];
    proxy.bindRefusals((refusal) => void sources.push(refusal.source));
    const port = await proxy.start();
    proxy.launched(grant("l1", null));
    await refused(port);
    proxy.ended("l1");
    proxy.launched(grant("l2", "nightly"));
    await refused(port);
    expect(sources).toEqual(["thread", { task: "nightly" }]);
    expect(lines.filter((line) => line.msg === "egress_vm_refused")).toEqual([]);
  });
});
