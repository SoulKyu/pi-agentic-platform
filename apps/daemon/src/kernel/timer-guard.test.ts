import { describe, expect, it } from "vitest";
import { guardTimer } from "./timer-guard.ts";
import { openOutboxBed } from "./testing/outbox-bed.ts";

describe("guardTimer", () => {
  it("runs the work and logs nothing when it succeeds", async () => {
    const bed = openOutboxBed();
    let ran = 0;
    await guardTimer(bed.logger, "ok", () => void ran++, bed.clock);
    expect(ran).toBe(1);
    expect(bed.logs).toEqual([]);
    bed.close();
  });

  it("logs a throw and a rejection once a minute per name, and never rethrows", async () => {
    const bed = openOutboxBed();
    const fails = (name: string, kind: "throw" | "reject") =>
      guardTimer(
        bed.logger,
        name,
        kind === "throw"
          ? () => {
              throw new Error("sqlite is gone");
            }
          : () => Promise.reject(new Error("sqlite is gone")),
        bed.clock,
      );
    await expect(fails("loop", "throw")).resolves.toBeUndefined();
    await expect(fails("loop", "reject")).resolves.toBeUndefined();
    await expect(fails("other", "throw")).resolves.toBeUndefined();
    expect(bed.logs.map((l) => l.msg)).toEqual(["loop_failed", "other_failed"]);

    await bed.clock.advance(59_999);
    await fails("loop", "throw");
    expect(bed.logs).toHaveLength(2);
    await bed.clock.advance(1);
    await fails("loop", "throw");
    expect(bed.logs.map((l) => l.msg)).toEqual(["loop_failed", "other_failed", "loop_failed"]);
    expect(bed.logs[0]).toMatchObject({ level: "error", err: { message: "sqlite is gone" } });
    bed.close();
  });

  it("keeps the throttle per logger", async () => {
    const a = openOutboxBed();
    const b = openOutboxBed();
    const boom = () => {
      throw new Error("x");
    };
    await guardTimer(a.logger, "loop", boom, a.clock);
    await guardTimer(b.logger, "loop", boom, b.clock);
    expect(a.logs).toHaveLength(1);
    expect(b.logs).toHaveLength(1);
    a.close();
    b.close();
  });

  it("works with the system clock by default", async () => {
    const bed = openOutboxBed();
    await guardTimer(bed.logger, "x", () => {
      throw new Error("y");
    });
    expect(bed.logs).toHaveLength(1);
    bed.close();
  });
});
