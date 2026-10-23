import { expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createLogger, type Logger } from "../../kernel/logger.ts";
import { createHealthEvents, type HealthEventInput } from "./events.ts";

/** The bed logger (automation/testing/bed.ts): every line parsed, so a test can assert what was logged. */
function loggerOf(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    logger: createLogger({
      level: "debug",
      clock: createFakeClock(),
      write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    lines,
  };
}

it("a listener that throws is logged and skipped", () => {
  const heard: HealthEventInput[] = [];
  const { logger, lines } = loggerOf();
  const events = createHealthEvents(logger);
  events.on(() => {
    throw new Error("boom");
  });
  events.on((input) => void heard.push(input));
  const input: HealthEventInput = {
    ownerId: "u1",
    kind: "feed",
    code: "not_a_feed",
    sourceRef: null,
  };
  expect(() => events.emit(input)).not.toThrow();
  expect(heard).toEqual([input]);
  expect(lines).toContainEqual(expect.objectContaining({ level: "warn", msg: "health_listener_failed" }));
});

it("emit reaches every live listener and the unsubscribe stops delivery", () => {
  const events = createHealthEvents(loggerOf().logger);
  const first: HealthEventInput[] = [];
  const second: HealthEventInput[] = [];
  const off = events.on((input) => void first.push(input));
  events.on((input) => void second.push(input));
  const input: HealthEventInput = {
    ownerId: "u1",
    kind: "agent",
    code: "capacity",
    sourceRef: null,
  };
  events.emit(input);
  off();
  events.emit(input);
  expect(first).toEqual([input]);
  expect(second).toEqual([input, input]);
});
