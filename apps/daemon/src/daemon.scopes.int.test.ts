import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemClock } from "./kernel/clock.ts";
import { createLogger } from "./kernel/logger.ts";
import { NO_SCOPES, type WorkerScopes } from "./kernel/supervisor/scope.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

const ANSWER = { steps: [{ text: "unused" }] };

function recorder() {
  const order: string[] = [];
  const logger = createLogger({
    level: "warn",
    clock: createSystemClock(),
    write: (line) => {
      // The sessions module says so when it is created with a scripted provider.
      if ((JSON.parse(line) as { msg?: string }).msg === "test_provider_enabled")
        order.push("sessions module");
    },
  });
  const scopes = (sweep: () => Promise<void> = async () => {}): WorkerScopes => ({
    ...NO_SCOPES,
    sweep: async () => {
      order.push("sweep");
      await sweep();
    },
  });
  const probe = (made: WorkerScopes) => async () => {
    order.push("probe");
    return made;
  };
  return { order, logger, scopes, probe };
}

const started: TestDaemon[] = [];
afterEach(async () => {
  for (const daemon of started.splice(0).reverse()) await daemon.stop();
});

describe("worker scopes at boot", () => {
  it("probes, then sweeps this home's slice, before the sessions module can start a worker (M2R37)", async () => {
    const { order, logger, scopes, probe } = recorder();
    started.push(await startTestDaemon(ANSWER, { deps: { logger, probeScopes: probe(scopes()) } }));
    expect(order).toEqual(["probe", "sweep", "sessions module"]);
  });

  it("boots without scopes when the probe finds no user manager", async () => {
    // The real probe, an environment without XDG_RUNTIME_DIR and scopes asked for.
    const daemon = await startTestDaemon(ANSWER, { config: { workerScope: "auto" } });
    started.push(daemon);
    expect(daemon.daemon.port).toBe(daemon.port);
  });

  it("fails the boot when the sweep fails, and frees the home and the port", async () => {
    const { logger, scopes, probe } = recorder();
    const failing = scopes(() => Promise.reject(new Error("sweep failed")));
    const home = mkdtempSync(join(tmpdir(), "pap-scopes-home-"));
    try {
      const first = await startTestDaemon(ANSWER, {
        config: { home },
        deps: { logger, probeScopes: probe(failing) },
      }).catch((error: unknown) => error);
      expect(first).toEqual(new Error("sweep failed"));
      // The instance lock was released: a second daemon takes the same home.
      started.push(await startTestDaemon(ANSWER, { config: { home } }));
    } finally {
      await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
