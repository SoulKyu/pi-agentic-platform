import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AutomationSettings, PapError, type SandboxSpec } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createSandboxProbe, probeSandbox, type SandboxProbe } from "../../kernel/sandbox/probe.ts";
import { createPrecheckPort, createPrecheckStep, systemPrecheckDeps } from "./index.ts";
import { fakeAgentPorts, insertAgentTrigger } from "./testing/agent-fakes.ts";
import { type AutomationBed, createAutomationBed } from "./testing/bed.ts";
import { createAgentBinding } from "./trigger-agent.ts";

// The real /usr/bin/bwrap in temporary folders. CI must provide a working bwrap; locally the file skips with one line.
const clock = createSystemClock();
const probe: SandboxProbe = await probeSandbox(undefined, { timers: clock });
if (!probe.usable && process.env.CI)
  throw new Error("precheck.sandbox.int.test: CI must provide a working /usr/bin/bwrap");
if (!probe.usable)
  console.warn("precheck.sandbox.int.test: skipped: no usable /usr/bin/bwrap on this machine");

describe.skipIf(!probe.usable)("an agent trigger's precheck in the agent's sandbox (M11R68)", () => {
  // The fake owner home sits in the checkout (node_modules/.cache), never in /tmp: bwrap's empty /tmp would hide it for the wrong reason.
  let base: string;
  let bed: AutomationBed;
  const path = (...parts: string[]): string => join(base, ...parts);
  const agentHome = (): string => path("home", ".pap", "agents", "atlas");
  const hostTmp = `/tmp/pap-precheck-int-${process.pid}`;

  beforeAll(() => {
    const cache = fileURLToPath(new URL("../../../../../node_modules/.cache", import.meta.url));
    mkdirSync(cache, { recursive: true });
    base = mkdtempSync(join(cache, "pap-precheck-int-"));
    mkdirSync(path("home", ".ssh"), { recursive: true });
    writeFileSync(path("home", ".ssh", "id"), "PRIVATE-KEY");
    mkdirSync(agentHome(), { recursive: true });
    writeFileSync(join(agentHome(), "MEMORY.md"), "memory");
    mkdirSync(path("host"), { recursive: true });
    bed = createAutomationBed();
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(hostTmp, { force: true });
    bed.dispose();
  });

  const spec = (): SandboxSpec => ({
    bwrap: probe.usable ? probe.path : "/usr/bin/bwrap",
    view: "system",
    home: agentHome(),
    writable: null,
    hide: [path("home"), path("home", ".pap")],
    network: false,
    egress: null,
  });

  function stepFor(
    command: string,
    options: { sandbox?: () => Promise<SandboxSpec>; timeoutMs?: number } = {},
  ) {
    const binding = createAgentBinding();
    const fakes = fakeAgentPorts(base);
    fakes.add();
    fakes.precheckSandbox.mockImplementation(options.sandbox ?? (async () => spec()));
    binding.bind(fakes.ports);
    const id = insertAgentTrigger(bed.db, agentHome(), {
      id: `trg-${Math.random().toString(16).slice(2)}`,
      precheck: command,
    });
    const record = bed.triggers.get("u1", id);
    if (!record) throw new Error("trigger not saved");
    const precheck = createPrecheckPort({
      logger: bed.logger,
      env: { PATH: "/usr/bin:/bin", HOME: path("home"), GH_TOKEN: "ghp_leaked", LANG: "C.UTF-8" },
      runner: systemPrecheckDeps(clock, bed.logger),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    const step = createPrecheckStep({
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      settings: { automation: () => AutomationSettings.parse({}) },
      gates: { over: () => false },
      triggers: bed.triggers,
      precheck,
      agents: binding,
    });
    return { step, record };
  }

  it("sees no key, no token, no /srv, cannot write the home, and starts in the home", async () => {
    const { step, record } = stepFor(
      `cat "$HOME/.ssh/id" 2>&1; echo "token=[$GH_TOKEN]"; touch ${hostTmp} 2>&1; ls /srv 2>&1; touch x 2>&1; pwd`,
    );
    const result = await step.run(record, { source: "manual", gated: false, origin: "manual" });
    expect(result).toMatchObject({ kind: "go" });
    const output = (result as { precheck: string }).precheck;
    expect(output).not.toContain("PRIVATE-KEY");
    expect(output).toContain("token=[]");
    expect(output).toContain("/srv");
    expect(output).toMatch(/No such file or directory/);
    expect(output).toMatch(/Read-only file system/);
    expect(output.trimEnd().split("\n").at(-1)).toBe(agentHome());
    expect(existsSync(join(agentHome(), "x"))).toBe(false);
    expect(existsSync(hostTmp)).toBe(false);
    expect(readdirSync(agentHome())).toEqual(["MEMORY.md"]);
  });

  it("kills a precheck at its deadline and leaves no process behind", async () => {
    const { step, record } = stepFor("sleep 298.31", { timeoutMs: 1_200 });
    const result = await step.run(record, { source: "manual", gated: false, origin: "manual" });
    expect(result).toMatchObject({ kind: "stop", verdict: "error", detail: "precheck timeout" });
    const alive = (): string[] =>
      readdirSync("/proc")
        .filter((name) => /^\d+$/.test(name))
        .filter((name) => {
          try {
            return readFileSync(`/proc/${name}/cmdline`, "utf8").includes("sleep 298.31");
          } catch {
            return false;
          }
        });
    await vi.waitFor(() => expect(alive()).toEqual([]), { timeout: 8_000, interval: 100 });
  });

  it("is an error and runs nothing when the sandbox is unusable: PAP_BWRAP=/usr/bin/false", async () => {
    const refused = createSandboxProbe({ override: "/usr/bin/false", clock, logger: bed.logger });
    const marker = path("host", "ran");
    const { step, record } = stepFor(`touch ${marker}`, {
      sandbox: async () => {
        const checked = await refused.ensure();
        if (!checked.usable) throw new PapError("sandbox_unavailable");
        return spec();
      },
    });
    const result = await step.run(record, { source: "manual", gated: false, origin: "manual" });
    expect(result).toMatchObject({ kind: "stop", verdict: "error", detail: "sandbox_unavailable" });
    expect(existsSync(marker)).toBe(false);
    expect(
      bed.db.all("SELECT verdict, detail FROM trigger_fires WHERE trigger_id = $id", { id: record.id }),
    ).toEqual([{ verdict: "error", detail: "sandbox_unavailable" }]);
  });
});
