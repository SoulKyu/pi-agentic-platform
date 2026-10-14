import { describe, expect, it, vi } from "vitest";
import { startTestDaemon } from "./testing/harness.ts";

const order = vi.hoisted(() => [] as string[]);

// Each step records when it starts and, after a macrotask, when it ends: a sequential stop shows start, end, start, end.
const recorded = (name: string, run: () => Promise<void>) => async () => {
  order.push(`${name}:start`);
  await run();
  await new Promise((resolve) => setImmediate(resolve));
  order.push(`${name}:end`);
};

vi.mock("./compose-pi.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./compose-pi.ts")>();
  return {
    ...original,
    composePi: (deps: Parameters<typeof original.composePi>[0]) => {
      const pi = original.composePi(deps);
      return { ...pi, stopAll: recorded("pi", () => pi.stopAll()) };
    },
  };
});
vi.mock("./modules/sessions/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./modules/sessions/index.ts")>();
  return {
    ...original,
    createSessionsModule: (deps: Parameters<typeof original.createSessionsModule>[0]) => {
      const sessions = original.createSessionsModule(deps);
      return { ...sessions, shutdownAll: recorded("sessions", () => sessions.shutdownAll()) };
    },
  };
});
vi.mock("./kernel/supervisor/worker.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./kernel/supervisor/worker.ts")>();
  return {
    ...original,
    killAllWorkerGroups: () => {
      order.push("killAllWorkerGroups");
      return original.killAllWorkerGroups();
    },
  };
});

describe("the daemon's stop order", () => {
  it("stops the helpers together with the sessions, then kills the worker groups", async () => {
    const t = await startTestDaemon({ steps: [] });
    order.length = 0;
    await t.stop();
    expect(order.slice(0, 2).sort()).toEqual(["pi:start", "sessions:start"]);
    expect(order.slice(2, 4).sort()).toEqual(["pi:end", "sessions:end"]);
    expect(order[4]).toBe("killAllWorkerGroups");
  });
});
