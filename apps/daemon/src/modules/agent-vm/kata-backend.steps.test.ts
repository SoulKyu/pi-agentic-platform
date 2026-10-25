import { type BoxRef, DEFAULT_AGENT_RESOURCES } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createKataBackend } from "./kata-backend.ts";
import type { VmSpec } from "./runtime.ts";
import { createFakeVmd } from "./testing/fake-vmd.ts";

const SCOUT: BoxRef = { kind: "agent", id: "scout-0001" };
const spec = (extra: Partial<VmSpec> = {}): VmSpec => ({
  box: SCOUT,
  kind: "thread",
  taskKey: null,
  image: `pap-agent-agent-${"a".repeat(64)}`,
  resources: DEFAULT_AGENT_RESOURCES,
  ...extra,
});
const launch = (n: number) => ({ launchId: n.toString(16).padStart(32, "0"), token: "ab".repeat(32) });

function make() {
  const fake = createFakeVmd();
  const backend = createKataBackend({
    client: fake,
    images: { started: vi.fn(), stopped: vi.fn() },
    logger: silentLogger,
    notice: () => {},
  });
  const log: string[] = [];
  const steps = { step: (step: string, state: string) => void log.push(`${step}:${state}`) };
  return { fake, backend, log, steps: steps as never };
}

describe("kata backend launch steps", () => {
  it("marks disk and vm around the disk and the VM, and skips a disk it already knows", async () => {
    const { backend, log, steps } = make();
    await backend.start(spec(), launch(1), steps);
    expect(log).toEqual(["disk:running", "disk:done", "vm:running", "vm:done"]);
    log.length = 0;
    await backend.start(spec(), launch(2), steps);
    expect(log).toEqual(["disk:running", "disk:skipped", "vm:running", "vm:done"]);
  });

  it("skips the disk of an isolated task and leaves a failed VM start running for its opener to fail", async () => {
    const { fake, backend, log, steps } = make();
    await backend.start(spec({ kind: "isolated", taskKey: "c".repeat(32) }), launch(3), steps);
    expect(log).toEqual(["disk:skipped", "vm:running", "vm:done"]);
    log.length = 0;
    fake.failNext("vm.start", "unavailable");
    await expect(backend.start(spec(), launch(4), steps)).rejects.toThrow();
    expect(log.at(-1)).toBe("vm:running");
  });
});
