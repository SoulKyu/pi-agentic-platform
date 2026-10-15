import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { LANES_MIGRATIONS } from "./index.ts";
import { insertLane } from "./testing/lane-rows.ts";
import { createFakes, runnerOf, tempHome } from "./testing/script-fakes.ts";

let db: Db;
let clock: FakeClock;
let home: ReturnType<typeof tempHome>;
const logs = captureLogger();
beforeEach(() => {
  home = tempHome();
  clock = createFakeClock();
  db = migrate({
    dbPath: join(home.dir, "state.db"),
    backupsDir: join(home.dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock,
    logger: logs.logger,
  }).db;
});
afterEach(() => {
  db.close();
  home.dispose();
});

describe("ScriptRunner concurrency (M9R30)", () => {
  it("runs two scripts per owner and queues the third until one ends; another owner is not held", async () => {
    const fakes = createFakes();
    const runner = runnerOf({ db, clock, logger: logs.logger, home: join(home.dir, "pap"), fakes });
    const a = insertLane(db);
    const b = insertLane(db);
    const c = insertLane(db);
    const other = insertLane(db, { ownerId: "u2" });
    expect(await runner.run(a, "setup")).toEqual({ ok: true });
    expect(await runner.run(b, "setup")).toEqual({ ok: true });
    expect(await runner.run(c, "setup")).toEqual({ ok: true });
    expect(fakes.children).toHaveLength(2);
    expect(runner.state(c.id, "setup").state).toBe("queued");
    expect(await runner.run(other, "setup")).toEqual({ ok: true });
    expect(fakes.children).toHaveLength(3);
    expect(runner.state(other.id, "setup").state).toBe("running");
    fakes.child(0).end({ code: 0, signal: null });
    await vi.waitFor(() => expect(runner.state(c.id, "setup").state).toBe("running"), { timeout: 2000 });
    expect(fakes.children).toHaveLength(4);
    expect(fakes.child(3).spec.env.PAP_LANE_ID).toBe(c.id);
  });

  it("refuses a second run of a lane that is queued", async () => {
    const fakes = createFakes();
    const runner = runnerOf({
      db,
      clock,
      logger: logs.logger,
      home: join(home.dir, "pap"),
      fakes,
      extra: { perOwner: 1 },
    });
    const a = insertLane(db);
    const b = insertLane(db);
    await runner.run(a, "setup");
    await runner.run(b, "setup");
    expect(await runner.run(b, "test")).toEqual({ ok: false, reason: "running" });
  });

  it("interrupts a queued script at shutdown without spawning it", async () => {
    const fakes = createFakes();
    const runner = runnerOf({
      db,
      clock,
      logger: logs.logger,
      home: join(home.dir, "pap"),
      fakes,
      extra: { perOwner: 1 },
    });
    const a = insertLane(db);
    const b = insertLane(db);
    await runner.run(a, "setup");
    await runner.run(b, "setup");
    const stopped = runner.shutdown();
    fakes.child(0).end({ code: null, signal: "SIGTERM" });
    await stopped;
    expect(fakes.children).toHaveLength(1);
    expect(runner.state(b.id, "setup").state).toBe("interrupted");
  });
});
