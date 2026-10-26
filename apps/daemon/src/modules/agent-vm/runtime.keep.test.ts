import { beforeEach, describe, expect, it } from "vitest";
import { type Bed, bed, IDLE_MS, specOf, workerInput } from "./runtime-fixtures.ts";

const A1 = { kind: "agent", id: "a1" } as const;
const TASK = "c".repeat(32);
const KEEP = "d".repeat(32);

let b: Bed;
beforeEach(async () => {
  b = bed();
  await b.runtime.stopAll();
  b.backend.stop.mockClear();
});

describe("a kept task's VM holds its trigger's disk (K2)", () => {
  it("stops a second after its worker left, not after the idle time", async () => {
    const out = await b.runtime.spawn(
      specOf("a1", { kind: "isolated", taskKey: TASK, keepKey: KEEP }),
      workerInput(),
      null,
    );
    (out.handle as unknown as { end(): void }).end();
    await b.clock.advance(999);
    expect(b.backend.stop).not.toHaveBeenCalled();
    await b.clock.advance(1);
    expect(b.backend.stop).toHaveBeenCalledWith(A1, TASK, expect.any(String));
  });

  it("leaves a plain task's VM to the idle time", async () => {
    const out = await b.runtime.spawn(specOf("a1", { kind: "isolated", taskKey: TASK }), workerInput(), null);
    (out.handle as unknown as { end(): void }).end();
    await b.clock.advance(IDLE_MS - 1);
    expect(b.backend.stop).not.toHaveBeenCalled();
  });

  it("leaves a thread VM to the idle time even if its spec carried a key (M9)", async () => {
    const out = await b.runtime.spawn(
      specOf("a1", { kind: "thread", taskKey: null, keepKey: KEEP } as never),
      workerInput(),
      null,
    );
    (out.handle as unknown as { end(): void }).end();
    await b.clock.advance(IDLE_MS - 1);
    expect(b.backend.stop).not.toHaveBeenCalled();
  });
});
