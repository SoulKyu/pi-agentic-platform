import { linkSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createBoundaryBed } from "../testing/boundary-bed.ts";
import { createDenySet, DENY_WALK_DEADLINE_MS } from "./deny-set.ts";

// A mount that never answers: the walk's readdir waits on this gate until the test opens it.
const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      if (gate.wait) await gate.wait;
      return (actual.readdir as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readdir,
  };
});

let bed: ReturnType<typeof createBoundaryBed>;
let open: () => void = () => undefined;
beforeEach(() => {
  bed = createBoundaryBed();
});
afterEach(() => {
  gate.wait = null;
  bed.dispose();
});

describe("the first walk's deadline", () => {
  it("cannot vouch for anything while the walk is late, and vouches once it completes (R2)", async () => {
    expect(readdir).toBeTypeOf("function");
    gate.wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    const clock = createFakeClock(Date.now() + 3_600_000);
    const deny = createDenySet(bed.denySources(), clock);
    const ordinary = await stat(join(bed.proj, "src", "a.ts"), { bigint: true });
    const pending = deny.has(ordinary);
    await clock.advance(DENY_WALK_DEADLINE_MS - 1);
    expect(clock.pending()).toBeGreaterThan(0);
    await clock.advance(1);
    // Fail closed: even a file nobody linked is refused, because the set knows nothing yet.
    expect(await pending).toBe(true);
    // Later checks do not wait the deadline again.
    expect(await deny.has(ordinary)).toBe(true);
    open();
    await vi.waitFor(async () => expect(await deny.has(ordinary)).toBe(false), { timeout: 5000 });
    expect(await deny.has(await stat(join(bed.agentDir, "auth.json"), { bigint: true }))).toBe(true);
  });

  it("warns once when the first walk is late, and not when a later one is (MC38 m6)", async () => {
    gate.wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { logger, lines } = captureLogger();
    const clock = createFakeClock(Date.now() + 3_600_000);
    const deny = createDenySet(bed.denySources(), clock, undefined, undefined, { logger });
    deny.warm();
    await clock.advance(DENY_WALK_DEADLINE_MS - 1);
    expect(lines.filter((line) => line.msg === "deny_first_walk_late")).toEqual([]);
    await clock.advance(1);
    expect(lines.filter((line) => line.msg === "deny_first_walk_late")).toHaveLength(1);
    open();
  });

  it("refuses a linked file when a later walk outruns the deadline too", async () => {
    // A clock far behind: every file counts as changed after the first walk started, so a linked file asks for a new walk.
    const clock = createFakeClock(Date.now() - 3_600_000);
    const deny = createDenySet(bed.denySources(), clock);
    expect(await deny.has(await stat(join(bed.proj, "src", "a.ts"), { bigint: true }))).toBe(false);
    const alias = join(bed.proj, "a2.txt");
    linkSync(join(bed.proj, "a.txt"), alias);
    gate.wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    const pending = deny.has(await stat(alias, { bigint: true }));
    await clock.advance(DENY_WALK_DEADLINE_MS);
    expect(await pending).toBe(true);
    open();
  });

  it("starts at boot: the deadline runs from warm(), not from the first check (m4)", async () => {
    gate.wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    const clock = createFakeClock(Date.now() + 3_600_000);
    const deny = createDenySet(bed.denySources(), clock);
    deny.warm();
    await clock.advance(DENY_WALK_DEADLINE_MS);
    // No clock movement after this first check: it must not wait for a deadline of its own.
    const ordinary = await stat(join(bed.proj, "src", "a.ts"), { bigint: true });
    expect(await deny.has(ordinary)).toBe(true);
    open();
  });

  it("answers at once when the walk is quick, and leaves no timer behind", async () => {
    const clock = createFakeClock(Date.now() + 3_600_000);
    const deny = createDenySet(bed.denySources(), clock);
    expect(await deny.has(await stat(join(bed.proj, "src", "a.ts"), { bigint: true }))).toBe(false);
    expect(clock.pending()).toBe(0);
  });
});
