import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, bwrapArgv, type EgressStatus, type PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentGateDeps, agentGate, agentPrecheckSandbox } from "./agent-gate.ts";
import type { EgressPort } from "./egress-link.ts";
import type { SessionRow } from "./store.ts";
import { captureLogger } from "./testing/helpers.ts";

const ID = "atlas-1a2b";
const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
const USABLE: EgressStatus = { usable: true, python: "/usr/bin/python3.14", reason: null };
let root: string;
let papHome: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-gate-egress-")));
  papHome = join(root, "pap");
  mkdirSync(join(papHome, "agents", ID), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "home"), { mode: 0o700 });
  mkdirSync(join(root, "pi"), { mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const home = () => join(papHome, "agents", ID);
const row = (extra: Partial<SessionRow> = {}): SessionRow => ({
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: home(),
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
  agentId: ID,
  agentRole: "thread",
  ...extra,
});

interface Options {
  input?: object;
  status?: EgressStatus;
  forwarder?: string | null;
  bound?: boolean;
}
function setup(options: Options = {}) {
  const logs = captureLogger();
  const order: string[] = [];
  let status = options.status ?? USABLE;
  const egress = {
    ready: vi.fn(async () => void order.push("ready")),
    status: vi.fn(() => (order.push("status"), status)),
    forwarderPath:
      options.forwarder === undefined ? "/run/user/1000/pap/ab12cd/egress/fwd.py" : options.forwarder,
  } as unknown as EgressPort;
  const value: AgentGateDeps = {
    papHome,
    agentDir: join(root, "pi"),
    homeDir: () => join(root, "home"),
    profileOf: () => ({
      input: AgentInput.parse({ name: "Atlas", ...options.input }),
      name: "Atlas",
      quarantined: false,
    }),
    probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    logger: logs.logger,
    ...(options.bound === false ? {} : { egress }),
  };
  return {
    value,
    logs,
    egress,
    order,
    set: (next: EgressStatus) => void (status = next),
  };
}
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: PapError) => error.code,
  );
const NETWORK = { sandbox: { required: true, network: true } };

describe("the launch gate with a networked profile (M11R242)", () => {
  it("builds the spec with the probed interpreter and the daemon's forwarder, for a thread and a task", async () => {
    const { value } = setup({ input: NETWORK });
    const thread = await agentGate(row(), value);
    expect(thread.sandbox).toMatchObject({
      view: "host",
      network: true,
      egress: { python: "/usr/bin/python3.14", forwarder: "/run/user/1000/pap/ab12cd/egress/fwd.py" },
    });
    expect(() =>
      bwrapArgv(thread.sandbox as never, "true", "/run/user/1000/pap/ab12cd/egress/0/0.s"),
    ).not.toThrow();
    mkdirSync(join(papHome, "agents", ".runs", ID, TASK), { recursive: true, mode: 0o700 });
    const task = await agentGate(
      row({ agentRole: "task", cwd: join(papHome, "agents", ".runs", ID, TASK) }),
      value,
    );
    expect(task.sandbox).toMatchObject({
      view: "system",
      network: true,
      egress: { python: "/usr/bin/python3.14" },
    });
  });

  it("waits for the egress boot before it reads the status", async () => {
    const { value, order } = setup({ input: NETWORK });
    await agentGate(row(), value);
    expect(order).toEqual(["ready", "status"]);
  });

  it.each(["no_python", "unsafe_path", "socket_path"] as const)(
    "refuses with sandbox_unavailable and logs why when the proxy is %s",
    async (reason) => {
      const { value, logs } = setup({
        input: NETWORK,
        status: { usable: false, python: null, reason },
      });
      expect(await codeOf(agentGate(row(), value))).toBe("sandbox_unavailable");
      expect(logs.lines.find((line) => line.msg === "agent_egress_refused")).toMatchObject({
        agentId: ID,
        reason,
      });
    },
  );

  it("refuses when the proxy is usable but has no forwarder file, and when no egress module is bound", async () => {
    expect(await codeOf(agentGate(row(), setup({ input: NETWORK, forwarder: null }).value))).toBe(
      "sandbox_unavailable",
    );
    const unbound = setup({ input: NETWORK, bound: false });
    expect(await codeOf(agentGate(row(), unbound.value))).toBe("sandbox_unavailable");
    expect(unbound.logs.lines.find((line) => line.msg === "agent_egress_refused")).toMatchObject({
      reason: "unbound",
    });
  });

  it("never falls back to a network-off sandbox: no launch facts at all", async () => {
    const { value } = setup({ input: NETWORK, status: { usable: false, python: null, reason: "no_python" } });
    const launched = await agentGate(row(), value).then(
      (launch) => launch,
      () => null,
    );
    expect(launched).toBeNull();
  });

  it("a network-off agent has no egress and does not consult the proxy", async () => {
    const { value, egress } = setup({ input: { sandbox: { required: true, network: false } } });
    const launch = await agentGate(row(), value);
    expect(launch.sandbox).toMatchObject({ network: false, egress: null });
    expect(egress.status).not.toHaveBeenCalled();
  });

  it("an agent with the sandbox off has no spec and does not consult the proxy", async () => {
    const { value, egress } = setup({ input: { sandbox: { required: false, network: true } } });
    const launch = await agentGate(row(), value);
    expect(launch).not.toHaveProperty("sandbox");
    expect(egress.status).not.toHaveBeenCalled();
  });

  it("a proxy that turns unusable between two launches refuses the second", async () => {
    const world = setup({ input: NETWORK });
    await agentGate(row(), world.value);
    world.set({ usable: false, python: null, reason: "no_python" });
    expect(await codeOf(agentGate(row(), world.value))).toBe("sandbox_unavailable");
  });
});

describe("the precheck's sandbox with a networked profile (M11R242, W5-R31)", () => {
  it("is networked behind the proxy", async () => {
    const spec = await agentPrecheckSandbox(setup({ input: NETWORK }).value, "u1", ID);
    expect(spec).toMatchObject({
      view: "system",
      writable: null,
      network: true,
      egress: { python: "/usr/bin/python3.14" },
    });
  });

  it("is refused with sandbox_unavailable when the proxy is not usable", async () => {
    const world = setup({ input: NETWORK, status: { usable: false, python: null, reason: "socket_path" } });
    expect(await codeOf(agentPrecheckSandbox(world.value, "u1", ID))).toBe("sandbox_unavailable");
    expect(world.logs.lines.find((line) => line.msg === "agent_egress_refused")).toMatchObject({
      agentId: ID,
      reason: "socket_path",
    });
  });

  it("is network-off for a network-off agent, whatever the proxy says", async () => {
    const world = setup({ status: { usable: false, python: null, reason: "no_python" } });
    expect(await agentPrecheckSandbox(world.value, "u1", ID)).toMatchObject({ network: false, egress: null });
  });
});
