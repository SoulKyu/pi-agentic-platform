import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { LANES_MIGRATIONS } from "./index.ts";
import { insertLane } from "./testing/lane-rows.ts";
import { createFakes, runnerOf, tempHome } from "./testing/script-fakes.ts";

let db: Db;
let home: ReturnType<typeof tempHome>;
const logs = captureLogger();
beforeEach(() => {
  home = tempHome();
  db = migrate({
    dbPath: join(home.dir, "state.db"),
    backupsDir: join(home.dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock: createFakeClock(),
    logger: logs.logger,
  }).db;
});
afterEach(() => {
  db.close();
  home.dispose();
});

const orphan = (pgid: number, proc: string) => {
  const lane = insertLane(db);
  db.run(
    "UPDATE lanes SET setup_state = 'running', script_pgid = $pgid, script_proc = $proc WHERE id = $id",
    { id: lane.id, pgid, proc },
  );
  return lane;
};
const row = (id: string) =>
  db.get<Record<string, unknown>>("SELECT setup_state, script_pgid, script_proc FROM lanes WHERE id = $id", {
    id,
  });

describe("ScriptRunner.recover (M9R116)", () => {
  it("kills a group whose boot id and start time match, then marks the row interrupted; nothing is spawned", async () => {
    const fakes = createFakes();
    fakes.probe.starts.set(5000, "123");
    const lane = orphan(5000, "boot-1:123");
    const runner = runnerOf({ db, clock: createFakeClock(), logger: logs.logger, home: home.dir, fakes });
    await runner.recover();
    expect(fakes.signals).toEqual([{ pid: 5000, signal: "SIGKILL" }]);
    expect(row(lane.id)).toEqual({ setup_state: "interrupted", script_pgid: null, script_proc: null });
    expect(fakes.children).toHaveLength(0);
  });

  it("marks interrupted without a signal when the boot id differs", async () => {
    const fakes = createFakes();
    fakes.probe.starts.set(5000, "123");
    const lane = orphan(5000, "boot-OLD:123");
    const runner = runnerOf({ db, clock: createFakeClock(), logger: logs.logger, home: home.dir, fakes });
    await runner.recover();
    expect(fakes.signals).toEqual([]);
    expect(row(lane.id)?.setup_state).toBe("interrupted");
  });

  it("marks interrupted without a signal when the start time differs (a recycled pid)", async () => {
    const fakes = createFakes();
    fakes.probe.starts.set(5000, "999");
    const lane = orphan(5000, "boot-1:123");
    const runner = runnerOf({ db, clock: createFakeClock(), logger: logs.logger, home: home.dir, fakes });
    await runner.recover();
    expect(fakes.signals).toEqual([]);
    expect(row(lane.id)?.setup_state).toBe("interrupted");
  });

  it("never signals when /proc cannot tell the boot id", async () => {
    const fakes = createFakes();
    fakes.probe.boot = null;
    const lane = orphan(5000, "boot-1:1000");
    const runner = runnerOf({ db, clock: createFakeClock(), logger: logs.logger, home: home.dir, fakes });
    await runner.recover();
    expect(fakes.signals).toEqual([]);
    expect(row(lane.id)?.setup_state).toBe("interrupted");
  });

  it("turns a left-over queued state into interrupted, and leaves ok and pending alone", async () => {
    const fakes = createFakes();
    const queued = insertLane(db);
    const done = insertLane(db);
    db.run("UPDATE lanes SET setup_state = 'queued' WHERE id = $id", { id: queued.id });
    db.run("UPDATE lanes SET setup_state = 'ok' WHERE id = $id", { id: done.id });
    const runner = runnerOf({ db, clock: createFakeClock(), logger: logs.logger, home: home.dir, fakes });
    await runner.recover();
    expect(row(queued.id)?.setup_state).toBe("interrupted");
    expect(row(done.id)?.setup_state).toBe("ok");
  });
});
