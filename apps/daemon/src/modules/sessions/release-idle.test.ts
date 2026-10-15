import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { LiveSession } from "./live-session.ts";
import { createFolderRestart } from "./restart-folder.ts";
import type { SessionRow } from "./store.ts";

type State = {
  status?: string;
  busy?: boolean;
  stopping?: boolean;
  dialogs?: number;
  panels?: number;
  queued?: number;
};

function bed(rows: Record<string, Partial<SessionRow>>) {
  const live = new Map<string, LiveSession>();
  const reopening = new Map<string, unknown>();
  const waiting = new Set<string>();
  const stops: Record<string, ReturnType<typeof vi.fn>> = {};
  const add = (id: string, state: State) => {
    const stop = vi.fn(() => Promise.resolve());
    stops[id] = stop;
    live.set(id, {
      status: () => state.status ?? "idle",
      busy: () => state.busy ?? false,
      stopping: () => state.stopping ?? false,
      dialogs: () => Array.from({ length: state.dialogs ?? 0 }),
      panels: () => Array.from({ length: state.panels ?? 0 }),
      queue: () => ({ steering: [], followUp: [], count: state.queued ?? 0, bytes: 0 }),
      stop,
    } as unknown as LiveSession);
  };
  const restart = createFolderRestart({
    live,
    reopening,
    row: (id) => rows[id] as SessionRow | undefined,
    logger: silentLogger,
    waiting: (id) => waiting.has(id),
  });
  return { add, stops, reopening, waiting, release: restart.releaseIdle };
}

describe("releaseIdle (M9R113, M10R154)", () => {
  const rows = { s1: { ownerId: "u1", cwd: "/w" }, s2: { ownerId: "u2", cwd: "/w" } };

  it("stops the worker of a quiet session of the owner and answers released", () => {
    const { add, stops, release } = bed(rows);
    add("s1", {});
    expect(release("u1", "s1")).toBe("released");
    expect(stops.s1).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["running", { status: "running" }],
    ["starting", { status: "starting" }],
    ["busy", { busy: true }],
    ["an open dialog", { dialogs: 1 }],
    ["an open panel", { panels: 1 }],
    ["a queued prompt", { queued: 1 }],
  ])("leaves a session with %s alone and answers busy", (_name, state: State) => {
    const { add, stops, release } = bed(rows);
    add("s1", state);
    expect(release("u1", "s1")).toBe("busy");
    expect(stops.s1).not.toHaveBeenCalled();
  });

  it("answers busy, touching nothing, while a prompt waits in the lane hooks", () => {
    const { add, stops, waiting, release } = bed(rows);
    add("s1", {});
    waiting.add("s1");
    expect(release("u1", "s1")).toBe("busy");
    expect(stops.s1).not.toHaveBeenCalled();
  });

  it("answers busy for a worker being opened", () => {
    const { reopening, release } = bed(rows);
    reopening.set("s1", {});
    expect(release("u1", "s1")).toBe("busy");
  });

  it("answers cold for no worker, another owner's session, an unknown one or one already stopping", () => {
    const { add, stops, release } = bed(rows);
    expect(release("u1", "s1")).toBe("cold");
    add("s2", {});
    expect(release("u1", "s2")).toBe("cold");
    expect(release("u1", "missing")).toBe("cold");
    add("s1", { stopping: true });
    expect(release("u1", "s1")).toBe("cold");
    expect(stops.s1).not.toHaveBeenCalled();
    expect(stops.s2).not.toHaveBeenCalled();
  });
});
