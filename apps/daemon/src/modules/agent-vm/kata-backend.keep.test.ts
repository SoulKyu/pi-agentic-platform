import { type BoxRef, DEFAULT_AGENT_RESOURCES } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createKataBackend } from "./kata-backend.ts";
import type { VmSpec } from "./runtime.ts";
import { createFakeVmd } from "./testing/fake-vmd.ts";

const SCOUT: BoxRef = { kind: "agent", id: "scout-0001" };
const TASK = "c".repeat(32);
const KEEP = "d".repeat(32);
const task = (extra: Partial<VmSpec> = {}): VmSpec => ({
  box: SCOUT,
  kind: "isolated",
  taskKey: TASK,
  image: `pap-agent-agent-${"a".repeat(64)}`,
  resources: DEFAULT_AGENT_RESOURCES,
  ...extra,
});
const launch = { launchId: "1".repeat(32), token: "ab".repeat(32) };

function bed() {
  const fake = createFakeVmd();
  const backend = createKataBackend({
    client: fake,
    images: { started: vi.fn(), stopped: vi.fn() },
    logger: silentLogger,
    notice: () => {},
  });
  return { fake, backend };
}

describe("vm.start for a kept task (K2)", () => {
  it("carries the keep key", async () => {
    const { fake, backend } = bed();
    await backend.start(task({ keepKey: KEEP }), launch);
    expect(fake.of("vm.start")[0]).toMatchObject({ kind: "isolated", taskKey: TASK, keepKey: KEEP });
  });

  it("carries none for a plain task or a null key", async () => {
    for (const spec of [task(), task({ keepKey: null })]) {
      const { fake, backend } = bed();
      await backend.start(spec, launch);
      expect(fake.of("vm.start")[0]).not.toHaveProperty("keepKey");
    }
  });
});
