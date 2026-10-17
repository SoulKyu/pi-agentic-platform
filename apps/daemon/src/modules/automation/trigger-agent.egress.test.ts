import { AutomationSettings, PapError, type SandboxSpec } from "@pap/contracts";
import { join } from "node:path";
import { testCaller } from "../../testing/caller.ts";
import { createDryRun } from "./dry-run.ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrecheckStep, type PrecheckPort } from "./precheck-step.ts";
import { AGENT, fakeAgentPorts, insertAgentTrigger } from "./testing/agent-fakes.ts";
import { type AutomationBed, createAutomationBed } from "./testing/bed.ts";
import { createAgentBinding } from "./trigger-agent.ts";

// A networked agent's precheck runs behind its own proxy socket, released after the command ends (M11R243).
let bed: AutomationBed;
beforeAll(() => {
  bed = createAutomationBed();
});
afterAll(() => bed.dispose());

const spec = (network: boolean): SandboxSpec => ({
  bwrap: "/usr/bin/bwrap",
  view: "system",
  home: "/pap/agents/atlas-1a2b",
  writable: null,
  hide: ["/var/log"],
  network,
  egress: network ? { python: "/usr/bin/python3", forwarder: "/run/pap/egress/fwd.py" } : null,
});
const SOCKET = "/run/pap/egress/3/0.s";

function setup(options: { network: boolean; run?: PrecheckPort["run"]; open?: () => Promise<never> }) {
  const events: string[] = [];
  const binding = createAgentBinding();
  const fakes = fakeAgentPorts("/pap-fake-root");
  fakes.add();
  fakes.precheckSandbox.mockImplementation(async () => spec(options.network));
  const release = vi.fn(async () => void events.push("release"));
  const open = vi.fn(options.open ?? (async () => ({ socket: SOCKET, release })));
  binding.bind({
    ...fakes.ports,
    sessions: { ...fakes.ports.sessions, precheckEgress: open },
  });
  const argvs: string[][] = [];
  const port: PrecheckPort = {
    run: vi.fn(
      options.run ??
        (async (input) => {
          events.push("run");
          argvs.push(input.wrap?.("true") ?? []);
          return { verdict: "pass", exitCode: 0, durationMs: 1, output: "ok" };
        }),
    ),
  };
  const id = insertAgentTrigger(bed.db, "/pap/agents/atlas-1a2b", {
    id: `trg-${Math.random().toString(16).slice(2)}`,
    precheck: "check.sh",
  });
  const record = bed.triggers.get("u1", id);
  if (!record) throw new Error("trigger not saved");
  const step = createPrecheckStep({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    settings: { automation: () => AutomationSettings.parse({}) },
    gates: { over: () => false },
    triggers: bed.triggers,
    precheck: port,
    agents: binding,
  });
  return { step, record, open, release, events, argvs, port };
}
const how = { source: "manual", gated: false, origin: "manual" } as const;

describe("an agent trigger's networked precheck (M11R243)", () => {
  it("runs with its own socket bound at the sandbox's proxy path, and releases it after the command", async () => {
    const { step, record, open, release, events, argvs } = setup({ network: true });
    expect(await step.run(record, how)).toEqual({ kind: "go", precheck: "ok" });
    expect(open).toHaveBeenCalledWith("u1", AGENT);
    expect(events).toEqual(["run", "release"]);
    expect(release).toHaveBeenCalledTimes(1);
    const argv = argvs[0] ?? [];
    expect(argv.slice(argv.indexOf("--bind"), argv.indexOf("--bind") + 3)).toEqual([
      "--bind",
      SOCKET,
      "/run/pap-egress.sock",
    ]);
  });

  it("releases the socket when the command fails to spawn", async () => {
    const { step, record, release } = setup({
      network: true,
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(await step.run(record, how)).toMatchObject({ kind: "stop", verdict: "error" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the socket on a skip", async () => {
    const { step, record, release } = setup({
      network: true,
      run: async () => ({ verdict: "skip", exitCode: 1, durationMs: 1, output: "", detail: "nothing" }),
    });
    expect(await step.run(record, how)).toMatchObject({ kind: "stop", verdict: "precheck" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("runs nothing and answers sandbox_unavailable when no socket can be opened", async () => {
    const { step, record, port, release } = setup({
      network: true,
      open: async () => {
        throw new PapError("sandbox_unavailable");
      },
    });
    expect(await step.run(record, how)).toMatchObject({
      kind: "stop",
      verdict: "error",
      detail: "sandbox_unavailable",
    });
    expect(port.run).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("tells the port the command is proxied, so it gets pap's proxy variables and not the owner's", async () => {
    const seen: Array<boolean | undefined> = [];
    const on = setup({
      network: true,
      run: async (input) => (
        seen.push(input.proxied),
        { verdict: "pass", exitCode: 0, durationMs: 1, output: "" }
      ),
    });
    await on.step.run(on.record, how);
    const off = setup({
      network: false,
      run: async (input) => (
        seen.push(input.proxied),
        { verdict: "pass", exitCode: 0, durationMs: 1, output: "" }
      ),
    });
    await off.step.run(off.record, how);
    expect(seen).toEqual([true, false]);
  });

  it("a network-off precheck opens no socket and binds none", async () => {
    const { step, record, open, release, argvs } = setup({ network: false });
    expect(await step.run(record, how)).toEqual({ kind: "go", precheck: "ok" });
    expect(open).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(argvs[0]).not.toContain("/run/pap-egress.sock");
  });
});

describe("the dry run of a networked agent trigger releases its socket too (M11R243)", () => {
  const home = join("/pap-fake-root", "agents", AGENT);
  function dry(run: PrecheckPort["run"]) {
    const binding = createAgentBinding();
    const fakes = fakeAgentPorts("/pap-fake-root");
    fakes.add();
    fakes.precheckSandbox.mockImplementation(async () => ({ ...spec(true), home }));
    const release = vi.fn(async () => {});
    fakes.precheckEgress.mockImplementation(async () => ({ socket: SOCKET, release }));
    binding.bind(fakes.ports);
    const id = insertAgentTrigger(bed.db, home, {
      id: `trg-${Math.random().toString(16).slice(2)}`,
      precheck: "check.sh",
    });
    const run_ = createDryRun({
      clock: bed.clock,
      logger: bed.logger,
      triggers: bed.triggers,
      store: { queuedOfTrigger: () => 0 },
      gates: { over: () => false, spentToday: () => 0 },
      settings: { automation: () => AutomationSettings.parse({}) },
      precheck: { run },
      agents: binding,
    });
    return { run: () => run_.run(testCaller(), { triggerId: id }), release, fakes };
  }

  it("opens a socket for the run and releases it once, also when the command fails", async () => {
    const ok = dry(async () => ({ verdict: "pass", exitCode: 0, durationMs: 1, output: "ok" }));
    expect((await ok.run()).precheck).toMatchObject({ verdict: "pass" });
    expect(ok.fakes.precheckEgress).toHaveBeenCalledTimes(1);
    expect(ok.release).toHaveBeenCalledTimes(1);
    const failing = dry(async () => {
      throw new Error("spawn ENOENT");
    });
    expect((await failing.run()).precheck).toMatchObject({ verdict: "error" });
    expect(failing.release).toHaveBeenCalledTimes(1);
  });
});
