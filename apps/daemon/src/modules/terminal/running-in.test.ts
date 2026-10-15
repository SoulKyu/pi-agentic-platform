import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createTerminalRegistry } from "./registry.ts";
import { EXIT_QUIET_MS } from "./terminal.ts";
import { createFakePty, type FakePty } from "./testing/fake-pty.ts";

function setup() {
  const clock = createFakeClock();
  const ptys: FakePty[] = [];
  const registry = createTerminalRegistry({
    clock,
    logger: captureLogger().logger,
    maxTerminals: 8,
    minFreeMemMb: 0,
    freeMemMb: () => 10_000,
    launch: () => {
      const pty = createFakePty(1000 + ptys.length, clock);
      ptys.push(pty);
      return { pty, scope: null };
    },
    kill: async () => undefined,
  });
  const open = (ownerId: string, cwd: string) =>
    registry.create({ ownerId, cwd, sessionId: null, cols: 80, rows: 24 });
  return { clock, registry, ptys, open };
}

describe("registry.runningIn", () => {
  it("counts the owner's running terminals in the folder or below, and no other owner's or folder's", () => {
    const { registry, open } = setup();
    open("u1", "/wt/lane-a");
    open("u1", "/wt/lane-a/src");
    open("u1", "/wt/lane-b");
    open("u2", "/wt/lane-a");
    expect(registry.runningIn("u1", "/wt/lane-a")).toBe(2);
    expect(registry.runningIn("u1", "/wt/lane-b")).toBe(1);
    expect(registry.runningIn("u2", "/wt/lane-a")).toBe(1);
    expect(registry.runningIn("u3", "/wt/lane-a")).toBe(0);
    // A folder that merely starts with the same text is another folder.
    expect(registry.runningIn("u1", "/wt/lane")).toBe(0);
  });

  it("does not count a terminal whose shell has exited", async () => {
    const { clock, registry, ptys, open } = setup();
    open("u1", "/wt/lane-a");
    expect(registry.runningIn("u1", "/wt/lane-a")).toBe(1);
    ptys[0]?.exit(0, null);
    await clock.advance(EXIT_QUIET_MS);
    expect(registry.runningIn("u1", "/wt/lane-a")).toBe(0);
  });
});
