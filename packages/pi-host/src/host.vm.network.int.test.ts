import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRecord } from "./testing/fork-host.ts";
import { createHostBed, isApproval } from "./testing/host-bed.ts";
import { makeVmWorld } from "./testing/vm-world.ts";

// AVM2-E11, C2: the agent's `sandbox.network` reaches a VM worker's shell, its taint and its prompt (it was pinned to false).
// A fake bwrap records its argv and its environment instead of building a sandbox.
const WORKER = { timeoutMs: 30_000 };
const PROXY = "http://10.213.0.1:7843";
const SLOT = "0123456789abcdef0123456789abcdef";

let bed: ReturnType<typeof createHostBed>;
let world: ReturnType<typeof makeVmWorld>;
let argvDir: string;
let envDir: string;
beforeEach(() => {
  bed = createHostBed();
  world = makeVmWorld({ piAgentDir: bed.agentDir });
  argvDir = join(world.base, "argv");
  envDir = join(world.base, "env");
  mkdirSync(argvDir);
  mkdirSync(envDir);
  const fake = join(world.base, "fake-bwrap.sh");
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvDir}'/"$$"\nenv > '${envDir}'/"$$"\ncat <&3 >/dev/null\necho vm-ran\n`,
  );
  chmodSync(fake, 0o755);
});
afterEach(async () => {
  await bed.dispose();
  world.cleanup();
});

const linesOf = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"));
const endOf = (id: string) => (r: HostRecord) => r.type === "tool_execution_end" && r.toolCallId === id;

async function run(network: boolean) {
  const captured = join(world.base, "system.jsonl");
  await bed.start(
    {
      steps: [{ toolCalls: [{ name: "bash", args: { command: "echo hi" }, id: "c1" }] }, { text: "done" }],
      captureSystemPrompt: captured,
    },
    {
      env: { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY },
      policy: PolicyRules.parse({
        profile: "agent-thread",
        approvalMode: "full-access",
        agentHome: world.layout.home,
        sandbox: { required: true, network },
        readOnlyCommands: false,
      }),
      agentDirEnv: bed.agentDir,
      init: {
        cwd: world.layout.home,
        agentDir: bed.agentDir,
        agent: { id: "atlas-1a2b", name: "Atlas", role: "" },
        vm: {
          layout: world.layout,
          bwrap: join(world.base, "fake-bwrap.sh"),
          relayKey: "ab".repeat(32),
          slot: SLOT,
          rootView: "read-only",
        },
      },
    },
  );
  const host = bed.host();
  host.send({ type: "prompt", id: "p1", message: "go" });
  await host.waitFor(endOf("c1"), WORKER);
  await host.waitFor((r) => r.type === "agent_settled", WORKER);
  return { host, prompt: readFileSync(captured, "utf8"), argv: linesOf(argvDir), env: linesOf(envDir) };
}

describe("a VM worker and the agent's network switch", () => {
  it("on: the shell shares the network with the proxy variables, the prompt says so, the result taints, no card", async () => {
    const { host, prompt, argv, env } = await run(true);
    expect(argv).not.toContain("--unshare-net");
    expect(argv).toContain("--seccomp");
    expect(env).toContain(`HTTPS_PROXY=${PROXY}`);
    expect(prompt).toContain("the network is on");
    expect(host.records.filter((r) => r.type === "taint").length).toBeGreaterThan(0);
    expect(host.records.filter(isApproval)).toEqual([]);
  });
  it("off: --unshare-net, no proxy variable, the prompt says off, nothing taints", async () => {
    const { host, prompt, argv, env } = await run(false);
    expect(argv).toContain("--unshare-net");
    expect(env.some((line) => line.startsWith("HTTPS_PROXY="))).toBe(false);
    expect(prompt).toContain("the network is off");
    expect(host.records.filter((r) => r.type === "taint")).toEqual([]);
  });
});
