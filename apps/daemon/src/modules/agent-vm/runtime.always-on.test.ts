import { boxKey } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { CRASH_LIMIT, KEPT_IDLE_MS } from "./lifecycle.ts";
import { projectLayoutOf } from "./project-layout.ts";
import { type Bed, bed, IDLE_MS, PROJECT_ID, settle, specOf, workerInput } from "./runtime-fixtures.ts";

const PROJECT = { kind: "project", id: PROJECT_ID } as const;
const KEY = boxKey(PROJECT);
const TASK = "c".repeat(32);
const KEEP = "d".repeat(32);

let b: Bed;
let held: boolean;
let exits: string[];
const bindHooks = (): void => {
  b.runtime.bindAlwaysOn({
    holds: (box) => held && boxKey(box) === KEY,
    exited: (box) => void exits.push(boxKey(box)),
  });
};

beforeEach(async () => {
  held = true;
  exits = [];
  b = bed({ layout: () => projectLayoutOf("process", "/pap", PROJECT_ID) });
  await b.runtime.stopAll();
  b.backend.stop.mockClear();
});

describe("the idle hold of an always-on box", () => {
  it("keeps a started box with no worker running after twice the idle time", async () => {
    bindHooks();
    await b.runtime.start({ ...specOf("unused", { box: PROJECT }) });
    await b.clock.advance(2 * IDLE_MS);
    expect(b.backend.stop).not.toHaveBeenCalled();
    expect(b.runtime.phase(PROJECT)).toBe("running");
  });

  it("refreshIdle after holds turns false stops it at idleMs", async () => {
    bindHooks();
    await b.runtime.start(specOf("unused", { box: PROJECT }));
    await b.clock.advance(2 * IDLE_MS);
    held = false;
    b.runtime.refreshIdle(PROJECT);
    await b.clock.advance(IDLE_MS - 1);
    expect(b.backend.stop).not.toHaveBeenCalled();
    await b.clock.advance(1);
    expect(b.backend.stop).toHaveBeenCalledTimes(1);
  });

  it("refreshIdle is a no-op for an absent box and while a worker lives", async () => {
    bindHooks();
    held = false;
    b.runtime.refreshIdle(PROJECT);
    await b.runtime.spawn(specOf("unused", { box: PROJECT }), workerInput(), null);
    b.runtime.refreshIdle(PROJECT);
    await b.clock.advance(2 * IDLE_MS);
    expect(b.backend.stop).not.toHaveBeenCalled();
  });

  it("leaves a kept task's VM at KEPT_IDLE_MS whatever holds says", async () => {
    bindHooks();
    const out = await b.runtime.spawn(
      specOf("a1", { kind: "isolated", taskKey: TASK, keepKey: KEEP }),
      workerInput(),
      null,
    );
    (out.handle as unknown as { end(): void }).end();
    await b.clock.advance(KEPT_IDLE_MS);
    expect(b.backend.stop).toHaveBeenCalledTimes(1);
  });
});

describe("an unasked exit", () => {
  it("of an always-on box with no worker calls exited once, and three in ten minutes pause without a third call", async () => {
    bindHooks();
    for (let i = 0; i < CRASH_LIMIT; i++) {
      await b.runtime.start(specOf("unused", { box: PROJECT }));
      b.guestAt(-1).crash();
      await settle();
    }
    expect(exits).toEqual([KEY, KEY]);
    expect(b.crashPauses).toEqual([KEY]);
  });

  it("starts fresh from inside exited", async () => {
    let restarted = false;
    b.runtime.bindAlwaysOn({
      holds: () => true,
      exited: (box) => {
        void b.runtime.start(specOf("unused", { box })).then(() => {
          restarted = true;
        });
      },
    });
    await b.runtime.start(specOf("unused", { box: PROJECT }));
    b.guestAt(-1).crash();
    await settle();
    await settle();
    expect(restarted).toBe(true);
    expect(b.starts).toHaveLength(2);
  });

  it("of a box that is not always on, with no worker, calls nothing and records no crash", async () => {
    held = false;
    bindHooks();
    for (let i = 0; i < CRASH_LIMIT; i++) {
      await b.runtime.start(specOf("unused", { box: PROJECT }));
      b.guestAt(-1).crash();
      await settle();
    }
    expect(exits).toEqual([]);
    expect(b.crashPauses).toEqual([]);
  });

  it("is a no-op without bound hooks", async () => {
    await b.runtime.start(specOf("unused", { box: PROJECT }));
    b.guestAt(-1).crash();
    await settle();
    expect(b.crashPauses).toEqual([]);
    expect(b.runtime.phase(PROJECT)).toBe("stopped");
  });

  it("of an isolated task VM does not call exited", async () => {
    bindHooks();
    await b.runtime.spawn(
      specOf("unused", { box: PROJECT, kind: "isolated", taskKey: TASK }),
      workerInput(),
      null,
    );
    b.guestAt(-1).crash();
    await settle();
    expect(exits).toEqual([]);
  });

  it("of runtime.stop is not a crash and calls no exited", async () => {
    bindHooks();
    await b.runtime.start(specOf("unused", { box: PROJECT }));
    const guest = b.guestAt(-1);
    await b.runtime.stop(PROJECT);
    guest.crash();
    await settle();
    expect(exits).toEqual([]);
    expect(b.crashPauses).toEqual([]);
  });
});
