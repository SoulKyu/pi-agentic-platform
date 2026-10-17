import { afterEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createMemoryModule } from "./index.ts";
import { createMem0Layout, type Mem0Layout } from "./testing/layout.ts";

let layout: Mem0Layout;
let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  layout.dispose();
});

function build(env: NodeJS.ProcessEnv, piAgentDir: string) {
  layout = createMem0Layout();
  const warn = vi.fn();
  const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as unknown as Logger;
  Object.assign(logger, { child: () => logger });
  const module = createMemoryModule({
    core: { config: { piAgentDir }, env, clock: createFakeClock(), logger, readOnly: false },
    audit: { port: { append: () => {} } },
    inbox: { agentItems: { upsertAgentItem: () => true, resolveRef: () => true, openRefs: () => [] } },
    agents: {
      port: { get: () => null, list: () => [], ownerOf: () => null },
      setLinks: () => {},
    },
  });
  stop = module.stop;
  return { module, warn };
}

describe("where the memory module looks", () => {
  it("warns once for a relative PI_MEM0_DIR and falls back to <Pi agent dir>/mem0", async () => {
    const t = build({ PI_MEM0_DIR: "relative/mem0" }, "/nonexistent-pi");
    expect(t.warn).toHaveBeenCalledWith("memory_pi_mem0_dir_not_absolute");
    expect(await t.module.rpc["memory.status"]({}, { caller: testCaller() } as never)).toMatchObject({
      installed: false,
    });
  });

  it("warns for an empty PI_MEM0_DIR and falls back to <Pi agent dir>/mem0", () => {
    const t = build({ PI_MEM0_DIR: "" }, "/nonexistent-pi");
    expect(t.warn).toHaveBeenCalledWith("memory_pi_mem0_dir_not_absolute");
  });

  it("uses an absolute PI_MEM0_DIR without a warning", async () => {
    const other = createMem0Layout();
    try {
      const t = build({ PI_MEM0_DIR: other.mem0 }, "/nonexistent-pi");
      expect(t.warn).not.toHaveBeenCalledWith("memory_pi_mem0_dir_not_absolute");
      expect(await t.module.rpc["memory.status"]({}, { caller: testCaller() } as never)).toMatchObject({
        installed: true,
      });
      // The RPC hands the service the context's caller, so a token's status carries no capture text (final review M3).
      const token = { caller: testCaller({ kind: "token" }) } as never;
      expect(await t.module.rpc["memory.status"]({}, token)).toMatchObject({
        lastCaptureError: null,
        lastCaptureAt: null,
      });
    } finally {
      other.dispose();
    }
  });
});
