import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { codeOf } from "./security/testing/agent-bed.ts";
import { openOwner } from "./security/testing/automation-bed.ts";
import { captureLogger } from "./testing/capture-logger.ts";
import { loadConfig } from "./kernel/config.ts";
import { startTestDaemon } from "./testing/harness.ts";

describe("a daemon with no VM stack", () => {
  it("boots without a VM stack", async () => {
    const { logger, lines } = captureLogger();
    const t = await startTestDaemon(
      { steps: [{ text: "unused" }] },
      {
        config: { agentsRuntimeSet: true },
        deps: {
          logger,
          agentsVm: { kata: { socket: join(tmpdir(), "pap-no-such-vmd.sock"), kvm: () => true } },
        },
      },
    );
    try {
      const owner = await openOwner(t);
      const session = await owner.client.call("sessions.create", { cwd: t.cwd });
      expect(codeOf(session)).toBe("ok");
      const status = await owner.client.call("agents.vmStatus", {});
      expect(status.ok && (status.result as { usable: boolean }).usable).toBe(false);
      const created = await owner.client.call("agents.create", {
        input: AgentInput.parse({ name: "NoVm", mode: "full-access", preset: "full" }),
      });
      expect(codeOf(created)).toBe("sandbox_unavailable");
      expect(lines.filter((line) => line["msg"] === "agents_runtime_ignored")).toHaveLength(1);
      owner.client.close();
    } finally {
      await t.stop();
    }
  });

  it("logs agents_runtime_ignored once for a daemon whose environment sets PAP_AGENTS_RUNTIME", async () => {
    const { agentsRuntimeSet } = loadConfig({
      argv: [],
      env: { PAP_AGENTS_RUNTIME: "host" },
      cwd: "/tmp",
      homedir: "/home/u",
      totalMemMb: 16_384,
      piHostEntry: "/x/main.js",
      piHostExecArgv: [],
      staticRoot: null,
    });
    const { logger, lines } = captureLogger();
    const t = await startTestDaemon(
      { steps: [] },
      {
        config: { agentsRuntimeSet },
        deps: { logger, agentsVm: { kata: { socket: join(tmpdir(), "pap-no-such-vmd.sock") } } },
      },
    );
    await t.stop();
    expect(lines.filter((line) => line["msg"] === "agents_runtime_ignored")).toHaveLength(1);
  });
});
