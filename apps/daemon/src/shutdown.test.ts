import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { createShutdown, forceKill, STOP_DEADLINE_MS, watchSignals } from "./shutdown.ts";

function bed(stop: () => Promise<void>) {
  const clock = createFakeClock();
  const calls: string[] = [];
  const shutdown = createShutdown({
    stop: () => {
      calls.push("stop");
      return stop();
    },
    killWorkers: () => {
      calls.push("killWorkers");
      return 0;
    },
    exit: (code) => {
      calls.push(`exit ${code}`);
    },
    clock,
    logger: silentLogger,
  });
  return { shutdown, clock, calls };
}

describe("shutdown", () => {
  it("stops gracefully, then exits 0 without killing anything itself", async () => {
    const { shutdown, calls } = bed(() => Promise.resolve());
    shutdown.trigger("SIGTERM");
    await vi.waitFor(() => expect(calls).toEqual(["stop", "exit 0"]));
  });

  it("exits with the code of a fatal reason once the graceful stop is done", async () => {
    const { shutdown, calls } = bed(() => Promise.resolve());
    shutdown.trigger("server_error", 1);
    await vi.waitFor(() => expect(calls).toEqual(["stop", "exit 1"]));
  });

  it("starts the stop once and exits at once on a second signal, killing the workers first", async () => {
    const { shutdown, calls } = bed(() => new Promise<void>(() => {}));
    shutdown.trigger("SIGTERM");
    shutdown.trigger("SIGTERM");
    expect(calls).toEqual(["stop", "killWorkers", "exit 1"]);
    shutdown.trigger("SIGINT");
    expect(calls).toEqual(["stop", "killWorkers", "exit 1"]);
  });

  it("gives up on a stop that hangs when the deadline passes", async () => {
    const { shutdown, clock, calls } = bed(() => new Promise<void>(() => {}));
    shutdown.trigger("SIGTERM");
    await clock.advance(STOP_DEADLINE_MS - 1);
    expect(calls).toEqual(["stop"]);
    await clock.advance(1);
    expect(calls).toEqual(["stop", "killWorkers", "exit 1"]);
  });

  it("cancels the deadline once the stop is done", async () => {
    const { shutdown, clock, calls } = bed(() => Promise.resolve());
    shutdown.trigger("SIGTERM");
    await vi.waitFor(() => expect(calls).toEqual(["stop", "exit 0"]));
    expect(clock.pending()).toBe(0);
  });

  it("kills the workers and exits 1 when the stop fails", async () => {
    const { shutdown, calls } = bed(() => Promise.reject(new Error("db busy")));
    shutdown.trigger("SIGTERM");
    await vi.waitFor(() => expect(calls).toEqual(["stop", "killWorkers", "exit 1"]));
  });

  it("listens for SIGTERM, SIGINT and SIGHUP, and keeps listening for the second one", async () => {
    const { shutdown, calls } = bed(() => new Promise<void>(() => {}));
    const source = new EventEmitter();
    watchSignals(shutdown, source);
    expect(source.eventNames().sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    source.emit("SIGHUP");
    source.emit("SIGTERM");
    expect(calls).toEqual(["stop", "killWorkers", "exit 1"]);
  });
});

describe("forceKill", () => {
  const bedFor = (options: { groups?: () => number; scopes?: () => void } = {}) => {
    const calls: string[] = [];
    const lines: Array<{ msg: string; fields: unknown }> = [];
    const logger = {
      ...silentLogger,
      error: (msg: string, fields: unknown) => void lines.push({ msg, fields }),
    };
    const kill = forceKill({
      killWorkerGroups: () => {
        calls.push("groups");
        return options.groups?.() ?? 2;
      },
      killScopes: () => {
        calls.push("scopes");
        options.scopes?.();
      },
      logger,
    });
    return { kill, calls, lines };
  };

  it("SIGKILLs the worker groups, then every worker scope, and returns the groups killed", () => {
    const { kill, calls } = bedFor();
    expect(kill()).toBe(2);
    expect(calls).toEqual(["groups", "scopes"]);
  });

  it("still kills the groups when the scopes cannot be killed, and says so", () => {
    const { kill, calls, lines } = bedFor({
      scopes: () => {
        throw new Error("boom");
      },
    });
    expect(kill()).toBe(2);
    expect(calls).toEqual(["groups", "scopes"]);
    expect(lines.map((line) => line.msg)).toEqual(["force_kill_scopes_failed"]);
  });

  it("still kills the scopes when the groups cannot be killed", () => {
    const { kill, calls } = bedFor({
      groups: () => {
        throw new Error("boom");
      },
    });
    expect(kill()).toBe(0);
    expect(calls).toEqual(["groups", "scopes"]);
  });
});
