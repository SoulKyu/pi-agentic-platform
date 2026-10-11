import { describe, expect, it, vi } from "vitest";
import { hasCommand, onRegistryChange, registerCommand, runCommand } from "./registry.ts";

describe("command registry (Orca app-command-handlers)", () => {
  it("lets the latest registration answer and re-exposes the earlier one when it leaves", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerCommand("x.one", first);
    const offSecond = registerCommand("x.one", second);
    expect(runCommand("x.one")).toBe(true);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
    offSecond();
    runCommand("x.one");
    expect(first).toHaveBeenCalledOnce();
    offFirst();
    expect(hasCommand("x.one")).toBe(false);
  });

  it("reports a declined or unknown command as unclaimed", () => {
    const off = registerCommand("x.two", () => false);
    expect(runCommand("x.two")).toBe(false);
    expect(runCommand("x.none")).toBe(false);
    off();
  });

  it("tells listeners about registrations and removals; a second removal changes nothing", () => {
    const listener = vi.fn();
    const stop = onRegistryChange(listener);
    const off = registerCommand("x.three", () => {});
    off();
    off();
    stop();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
