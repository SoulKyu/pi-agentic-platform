import { describe, expect, it, vi } from "vitest";
import { createNodePtyLoader, loadNodePty, type NodePty } from "./load.ts";
import type { Logger } from "../logger.ts";

function recordingLogger(): { log: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => log };
  return { log, warn };
}

describe("createNodePtyLoader", () => {
  it("answers null and logs terminal_unavailable once when the require throws, then never retries", () => {
    const attempt = vi.fn((): NodePty => {
      throw new Error("pty.node: cannot open shared object file");
    });
    const { log, warn } = recordingLogger();
    const load = createNodePtyLoader(attempt);
    expect(load(log)).toBeNull();
    expect(load(log)).toBeNull();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("terminal_unavailable", { reason: "node_pty_load_failed" });
  });

  it("returns the module without logging when the require works, and loads it once", () => {
    const module = { spawn: vi.fn() } as unknown as NodePty;
    const attempt = vi.fn(() => module);
    const { log, warn } = recordingLogger();
    const load = createNodePtyLoader(attempt);
    expect(load(log)).toBe(module);
    expect(load(log)).toBe(module);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("loadNodePty", () => {
  it("loads the real node-pty built by pnpm install", () => {
    const { log, warn } = recordingLogger();
    const pty = loadNodePty(log);
    expect(typeof pty?.spawn).toBe("function");
    expect(warn).not.toHaveBeenCalled();
  });
});
