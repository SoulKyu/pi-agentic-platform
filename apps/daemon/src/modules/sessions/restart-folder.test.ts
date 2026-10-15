import { describe, expect, it, vi } from "vitest";
import type { LiveSession } from "./live-session.ts";
import { createFolderRestart } from "./restart-folder.ts";
import type { SessionRow } from "./store.ts";
import { silentLogger } from "../../kernel/logger.ts";

const idleWorker = () => {
  const stop = vi.fn(() => Promise.resolve());
  const session = { stopping: () => false, status: () => "idle", busy: () => false, stop };
  return { session: session as unknown as LiveSession, stop };
};

describe("createFolderRestart (M7R105)", () => {
  it("keeps a pending first run when a second decision lands right after the worker came up", async () => {
    const live = new Map<string, LiveSession>();
    const reopening = new Map<string, unknown>([["s1", {}]]);
    const row = { ownerId: "o", cwd: "/w" } as SessionRow;
    const restart = createFolderRestart({
      live,
      reopening,
      row: () => row,
      logger: silentLogger,
      waiting: () => false,
    });
    restart.restart("o", "/w");
    const { session, stop } = idleWorker();
    reopening.delete("s1");
    live.set("s1", session);
    restart.reopened("s1");
    restart.restart("o", "/w");
    expect(stop).not.toHaveBeenCalled();
    restart.published("s1", { kind: "status", status: "running" } as never);
    restart.published("s1", { kind: "status", status: "idle" } as never);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
