import { connect, createServer, type Server, type Socket } from "node:net";
import { type BoxRef, boxKey, DEFAULT_PROJECT_RESOURCES, PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeVmProxy } from "./compose-agents-vm-proxy.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { createFakeWorker } from "./kernel/testing/fake-worker.ts";
import { boxRow, lateWithBoxes, PROJECT } from "./testing/late-boxes.ts";
import { loopbackVmSeams } from "./modules/egress/testing/vm.ts";
import { projectLayoutOf, type VmSpec } from "./modules/agent-vm/index.ts";
import { createVmLaunch, type SessionRow } from "./modules/sessions/index.ts";

const LISTED = "feed.example.test";
const layout = projectLayoutOf("process", "/pap", PROJECT);
const IMAGE = `pap-agent-agent-${"c".repeat(64)}`;

const row = (id: string): SessionRow =>
  ({ id, ownerId: "u1", cwd: layout.project, piPath: null }) as SessionRow;
const hostInit = (r: SessionRow) => ({
  type: "init" as const,
  cwd: r.cwd,
  agentDir: "/host/pi",
  papHome: "/pap",
  umask: 0o022,
  papSessionId: r.id,
  policy: PolicyRules.parse({
    profile: "project",
    approvalMode: "supervised",
    agentHome: layout.project,
    sandbox: { required: true, network: true },
  }),
});
const tunnel = (port: number): Promise<Socket> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    socket.once("data", () => resolve(socket));
    socket.write(`CONNECT ${LISTED}:443 HTTP/1.1\r\nHost: ${LISTED}:443\r\n\r\n`);
  });

describe("the sessions of one project box share a launch, and so its taint (spec 4)", () => {
  const closers: Array<{ name: string; close(): void | Promise<void> }> = [];
  const open: Socket[] = [];
  let echo: Server;
  let tainted: string[];
  let proxy: ReturnType<typeof composeVmProxy>;
  let port: number;
  let launchIds: string[];
  let running: string | null;
  let vmLaunch: ReturnType<typeof createVmLaunch>;
  /** The sessions the policy holds as tainted when they join (a task that starts tainted). */
  let startsTainted: Set<string>;

  beforeEach(async () => {
    tainted = [];
    startsTainted = new Set();
    launchIds = [];
    running = null;
    echo = createServer((socket) => socket.on("error", () => {}).pipe(socket));
    const echoPort = await new Promise<number>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve((echo.address() as { port: number }).port)),
    );
    const { derived } = lateWithBoxes({ rows: { [PROJECT]: boxRow({ hosts: [LISTED] }) } });
    proxy = composeVmProxy({
      clock: createFakeClock(),
      logger: silentLogger,
      bind: undefined,
      late: () => derived,
      closers,
      seams: loopbackVmSeams({ [LISTED]: { 443: echoPort } }),
    });
    proxy.bindTaint((sessionId) => void tainted.push(sessionId));
    port = await proxy.start();
    // The runtime's rule for a key: one VM while it runs, so a second spawn of the key joins the launch it has.
    const spawn = vi.fn(async (spec: VmSpec) => {
      const key = `${boxKey(spec.box as BoxRef)}|${spec.taskKey ?? ""}`;
      if (running?.startsWith(key) !== true) {
        const launchId = `launch-${launchIds.length + 1}`;
        launchIds.push(launchId);
        running = `${key}|${launchId}`;
        proxy.launched({
          launchId,
          box: spec.box,
          relayKey: "k",
          address: "127.0.0.1",
          taskKey: spec.taskKey,
        });
      }
      return {
        handle: Object.assign(createFakeWorker({}), { slot: "b".repeat(32), piFile: () => null }),
        layout,
        relayKey: "a".repeat(64),
        slot: "b".repeat(32),
        launchId: running.split("|")[2] ?? "",
      };
    });
    vmLaunch = createVmLaunch({
      runtime: { spawn } as never,
      papHome: "/pap",
      layoutOf: () => layout,
      joinLaunch: (launchId, sessionId, project) =>
        proxy.join(launchId, sessionId, project !== undefined && startsTainted.has(sessionId)),
      imageTagOf: () => IMAGE,
      projectImageTagOf: () => IMAGE,
      mirrors: {
        inputFor: () => ({
          sessionFile: null,
          sessionsDir: "/ignored",
          mirrorFor: () => "refused",
          unsent: () => false,
          sent: () => {},
        }),
      },
      logger: silentLogger,
      packageSources: async () => null,
      toImageEntries: () => null,
    });
  });
  afterEach(async () => {
    for (const socket of open.splice(0)) socket.destroy();
    for (const closer of closers.splice(0)) await closer.close();
    await new Promise((resolve) => echo.close(resolve));
  });

  const launch = (id: string) =>
    vmLaunch.spawn(
      row(id),
      {
        project: { id: PROJECT },
        resources: DEFAULT_PROJECT_RESOURCES,
        scope: layout.project ?? "",
        home: layout.home,
        vm: true,
      },
      hostInit(row(id)),
    );

  it("a session and a task of one project launch share its taint, and a new launch starts clean", async () => {
    await launch("session-1");
    await launch("task-1");
    expect(launchIds).toEqual(["launch-1"]);
    open.push(await tunnel(port));
    open.push(await tunnel(port));
    expect(tainted.sort()).toEqual(["session-1", "task-1"]);

    // The VM stops (idle, a restart): its launch ends, and a session of the next launch is clean.
    proxy.ended("launch-1");
    running = null;
    await launch("session-2");
    expect(launchIds).toEqual(["launch-1", "launch-2"]);
    expect(tainted.sort()).toEqual(["session-1", "task-1"]);
  });

  it("a task that starts tainted taints the live session of its launch and the one that starts later", async () => {
    await launch("session-1");
    startsTainted.add("task-1");
    await launch("task-1");
    expect(tainted.sort()).toEqual(["session-1", "task-1"]);
    await launch("session-2");
    expect(tainted.sort()).toEqual(["session-1", "session-2", "task-1"]);

    proxy.ended("launch-1");
    running = null;
    await launch("session-3");
    expect(launchIds).toEqual(["launch-1", "launch-2"]);
    expect(tainted).not.toContain("session-3");
  });

  it("a taint a worker reports taints the launch, once", async () => {
    await launch("session-1");
    await launch("session-2");
    proxy.raised("session-1");
    proxy.raised("session-2");
    expect(tainted.sort()).toEqual(["session-1", "session-2"]);
    await launch("session-3");
    expect(tainted.sort()).toEqual(["session-1", "session-2", "session-3"]);
    proxy.raised("unknown-session");
    expect(tainted).toHaveLength(3);
  });
});
