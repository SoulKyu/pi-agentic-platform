import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { composeVmProxy } from "./compose-agents-vm-proxy.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { loopbackVmSeams } from "./modules/egress/testing/vm.ts";
import { captureLogger } from "./testing/capture-logger.ts";
import { boxRow, lateWithBoxes, PROJECT } from "./testing/late-boxes.ts";

const PROJECT_BOX = { kind: "project", id: PROJECT } as const;

const grant = (launchId: string, taskKey: string | null) => ({
  launchId,
  box: { kind: "agent", id: "atlas-1a2b" } as const,
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
    expect(line).toMatchObject({ box: "agent:atlas-1a2b", port: 443, reason: "not_listed" });
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

  it("scopes a connection to its box: an agent box is judged by its list, a project box by its own", async () => {
    const { logger, lines } = captureLogger();
    const asked: string[] = [];
    const proxy = composeVmProxy({
      clock: createFakeClock(),
      logger,
      bind: undefined,
      late: () => ({
        hostsOf: (agentId) => (asked.push(agentId), ["listed.example.test"]),
        trustedOf: () => [],
        hostsOfProject: () => null,
      }),
      closers,
    });
    const refusals: unknown[] = [];
    proxy.bindRefusals((refusal) => void refusals.push(refusal.box));
    const port = await proxy.start();

    proxy.launched(grant("l1", null));
    await refused(port);
    proxy.ended("l1");
    proxy.launched({ ...grant("l2", null), box: PROJECT_BOX });
    expect(await refused(port)).toMatch(/^HTTP\/1\.1 403/);

    // An unknown or deleting project has no list (null): its source is refused before any host is judged.
    expect(refusals).toEqual([grant("l1", null).box]);
    // The project's id is never taken for an agent's: its list is not the agent's.
    expect(asked.every((id) => id === "atlas-1a2b")).toBe(true);
    expect(lines.filter((line) => line.msg === "egress_vm_refused")).toEqual([]);
  });

  it("refuses a project box before the late binding gives its list", async () => {
    const proxy = composeVmProxy({
      clock: createFakeClock(),
      logger: captureLogger().logger,
      bind: undefined,
      late: () => ({ hostsOf: () => [], trustedOf: () => [] }),
      closers,
    });
    const port = await proxy.start();
    proxy.launched({ ...grant("l1", null), box: PROJECT_BOX });
    expect(await refused(port)).toMatch(/^HTTP\/1\.1 403/);
  });
});

describe("the VMs' proxy for a project box", () => {
  const closers: Array<{ name: string; close(): void | Promise<void> }> = [];
  let echo: Server;
  const open: Socket[] = [];
  afterEach(async () => {
    for (const socket of open.splice(0)) socket.destroy();
    for (const closer of closers.splice(0)) await closer.close();
    await new Promise((resolve) => echo.close(resolve));
  });

  /** The first line of what the proxy answers to a CONNECT to the host: `HTTP/1.1 200 ...` through, or `403` refused. */
  const verdict = (port: number, host: string): Promise<string> =>
    new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      open.push(socket);
      socket.on("error", () => resolve("error"));
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString().split("\r\n")[0] ?? ""));
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });

  it("a project box reaches the owner's hosts and its own, and no other", async () => {
    echo = createServer((socket) => socket.on("error", () => {}).pipe(socket));
    const echoPort = await new Promise<number>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve((echo.address() as { port: number }).port)),
    );
    const { derived } = lateWithBoxes({
      rows: { [PROJECT]: boxRow({ hosts: ["project.example.test"] }) },
      ownerHosts: () => ["owner.example.test"],
    });
    const proxy = composeVmProxy({
      clock: createFakeClock(),
      logger: captureLogger().logger,
      bind: undefined,
      late: () => derived,
      closers,
      seams: loopbackVmSeams({
        "owner.example.test": { 443: echoPort },
        "project.example.test": { 443: echoPort },
        "other.example.test": { 443: echoPort },
      }),
    });
    const port = await proxy.start();
    proxy.launched({ ...grant("l1", null), box: PROJECT_BOX });
    expect(await verdict(port, "owner.example.test")).toMatch(/^HTTP\/1\.1 200/);
    expect(await verdict(port, "project.example.test")).toMatch(/^HTTP\/1\.1 200/);
    expect(await verdict(port, "other.example.test")).toMatch(/^HTTP\/1\.1 403/);
  });

  it("reads the list on every connection: a host added later is reached at once, a deleting project is refused", async () => {
    echo = createServer((socket) => socket.on("error", () => {}).pipe(socket));
    const echoPort = await new Promise<number>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve((echo.address() as { port: number }).port)),
    );
    const row = boxRow();
    const { derived } = lateWithBoxes({ rows: { [PROJECT]: row } });
    const proxy = composeVmProxy({
      clock: createFakeClock(),
      logger: captureLogger().logger,
      bind: undefined,
      late: () => derived,
      closers,
      seams: loopbackVmSeams({ "late.example.test": { 443: echoPort } }),
    });
    const port = await proxy.start();
    proxy.launched({ ...grant("l1", null), box: PROJECT_BOX });
    expect(await verdict(port, "late.example.test")).toMatch(/^HTTP\/1\.1 403/);
    (row.hosts as string[]).push("late.example.test");
    expect(await verdict(port, "late.example.test")).toMatch(/^HTTP\/1\.1 200/);
    (row as { deleting: boolean }).deleting = true;
    expect(await verdict(port, "late.example.test")).toMatch(/^HTTP\/1\.1 403/);
  });
});
