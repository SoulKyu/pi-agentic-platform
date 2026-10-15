import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { silentLogger, type LogFields, type Logger } from "../logger.ts";
import { createStallMonitor, SAMPLE_EVERY_MS, type LoopReading } from "./stall.ts";
import { createTracer } from "./tracer.ts";

const NS = 1_000_000;
const reading = (delayMaxMs: number, activeMs: number): LoopReading => ({
  delayMaxNs: delayMaxMs * NS,
  activeMs,
});

function setup(readings: Array<LoopReading | Error>) {
  const clock = createFakeClock(5_000_000);
  const warns: Array<{ msg: string; fields: LogFields | undefined }> = [];
  const errors: string[] = [];
  const logger: Logger = {
    ...silentLogger,
    warn: (msg, fields) => void warns.push({ msg, fields }),
    error: (msg) => void errors.push(msg),
  };
  const lines: string[] = [];
  const tracer = createTracer({ clock, file: { append: (line) => void lines.push(line) } });
  let taken = 0;
  const monitor = createStallMonitor({
    clock,
    logger,
    tracer,
    sampler: {
      sample() {
        const next = readings[Math.min(taken++, readings.length - 1)];
        if (next instanceof Error) throw next;
        return next ?? reading(1000, 0);
      },
      stop: () => {},
    },
  });
  return { clock, monitor, warns, errors, lines, taken: () => taken };
}

describe("event-loop stall monitor", () => {
  it("reports a delay max of 3.5 s over 3 s of activity as a stall of 2500 ms", async () => {
    const { clock, monitor, warns, lines } = setup([reading(3500, 3000)]);
    monitor.start();
    await clock.advance(SAMPLE_EVERY_MS);
    expect(warns).toEqual([{ msg: "event_loop_stall", fields: { ms: 2500 } }]);
    expect(monitor.counters()).toEqual({
      stalls: 1,
      lastStallMs: 2500,
      maxStallMs: 2500,
      totalStallMs: 2500,
    });
    const span = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(span).toMatchObject({ name: "event_loop.stall", durationMs: 2500, outcome: "ok" });
    monitor.stop();
  });

  it("ignores 2.9 s, whose stall is 1900 ms", async () => {
    const { clock, monitor, warns, lines } = setup([reading(2900, 2900)]);
    monitor.start();
    await clock.advance(SAMPLE_EVERY_MS);
    expect(warns).toEqual([]);
    expect(lines).toEqual([]);
    expect(monitor.counters().stalls).toBe(0);
    monitor.stop();
  });

  it("ignores a delay with no activity (a suspended laptop)", async () => {
    const { clock, monitor, warns } = setup([reading(60_000, 10)]);
    monitor.start();
    await clock.advance(SAMPLE_EVERY_MS);
    expect(warns).toEqual([]);
    expect(monitor.counters().stalls).toBe(0);
    monitor.stop();
  });

  it("samples every 30 s on the clock, and not before", async () => {
    const { clock, monitor, taken } = setup([reading(1000, 0)]);
    monitor.start();
    await clock.advance(SAMPLE_EVERY_MS - 1);
    expect(taken()).toBe(0);
    await clock.advance(1);
    expect(taken()).toBe(1);
    await clock.advance(SAMPLE_EVERY_MS * 2);
    expect(taken()).toBe(3);
    monitor.stop();
    await clock.advance(SAMPLE_EVERY_MS * 2);
    expect(taken()).toBe(3);
  });

  it("rate-limits the log to one a minute, and counts every stall", async () => {
    const { clock, monitor, warns, lines } = setup([reading(4000, 4000)]);
    monitor.start();
    await clock.advance(SAMPLE_EVERY_MS); // t=30 s: logged
    await clock.advance(SAMPLE_EVERY_MS); // t=60 s: 30 s later, held back
    expect(warns).toHaveLength(1);
    await clock.advance(SAMPLE_EVERY_MS); // t=90 s: 60 s after the first
    expect(warns).toHaveLength(2);
    expect(monitor.counters().stalls).toBe(3);
    expect(monitor.counters().totalStallMs).toBe(9000);
    expect(lines).toHaveLength(3);
    monitor.stop();
  });

  it("logs a sampler that throws once and still takes the next sample", async () => {
    const { clock, monitor, errors, warns, taken } = setup([
      new Error("histogram gone"),
      new Error("histogram gone"),
      reading(3500, 3500),
    ]);
    monitor.start();
    await clock.advance(SAMPLE_EVERY_MS * 3);
    expect(taken()).toBe(3);
    expect(errors).toEqual(["event_loop_sample_failed"]);
    expect(warns).toHaveLength(1);
    monitor.stop();
  });
});
