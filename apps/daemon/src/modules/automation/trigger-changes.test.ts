import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createLogger } from "../../kernel/logger.ts";
import { createTriggerChanges } from "./trigger-changes.ts";
import type { TriggerChanged } from "./triggers.ts";

const change: TriggerChanged = { ownerId: "u1", triggerId: "g1", removed: false };

function setup(forward: (change: TriggerChanged) => void = () => {}) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "warn",
    clock: createFakeClock(),
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { changes: createTriggerChanges(logger, forward), lines };
}

describe("trigger change listeners (Overview)", () => {
  it("runs the forward call, then tells each listener once per change, until it stops", () => {
    const order: string[] = [];
    const { changes } = setup(() => void order.push("forward"));
    const stop = changes.onTriggerChanged((heard) => void order.push(`listener:${heard.triggerId}`));
    changes.changed(change);
    expect(order).toEqual(["forward", "listener:g1"]);
    stop();
    changes.changed(change);
    expect(order).toEqual(["forward", "listener:g1", "forward"]);
  });

  it("logs a throwing listener and still tells the next one", () => {
    const { changes, lines } = setup();
    const heard: TriggerChanged[] = [];
    changes.onTriggerChanged(() => {
      throw new Error("listener");
    });
    changes.onTriggerChanged((next) => void heard.push(next));
    expect(() => changes.changed(change)).not.toThrow();
    expect(heard).toEqual([change]);
    expect(lines.filter((line) => line.msg === "trigger_listener_failed")).toHaveLength(1);
  });

  it("tells the listeners even when the forward call throws, and lets that throw reach the caller", () => {
    const { changes } = setup(() => {
      throw new Error("stream");
    });
    const heard: TriggerChanged[] = [];
    changes.onTriggerChanged((next) => void heard.push(next));
    expect(() => changes.changed(change)).toThrow("stream");
    expect(heard).toEqual([change]);
  });
});
