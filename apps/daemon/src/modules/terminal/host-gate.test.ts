import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { testCaller } from "../../testing/caller.ts";
import { makeModuleBed } from "./testing/module-bed.ts";

/** Every call into the host file system is counted: a refused member folder makes none. */
const fsCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const counted = Object.fromEntries(
    Object.entries(real).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            fsCalls.count++;
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  );
  return { ...counted, default: counted };
});

const boxes = createFakeProjectBoxSource({});
let bed: ReturnType<typeof makeModuleBed>;
afterEach(() => bed.cleanup());

describe("a member's terminal (M14)", () => {
  it("on a host folder answers forbidden before the folder is judged, with no fs call and no shell", async () => {
    bed = makeModuleBed({ module: { isMember: (id) => id === "m1", boxes: () => boxes } });
    fsCalls.count = 0;
    const created = bed.create({}, bed.ctxOf(testCaller({ userId: "m1" })));
    await expect(created).rejects.toMatchObject({ code: "forbidden" });
    expect(fsCalls.count).toBe(0);
    expect(bed.judged).toEqual([]);
    expect(bed.fake.children).toHaveLength(0);
  });

  it("the owner still gets their host shell", async () => {
    bed = makeModuleBed({ module: { isMember: (id) => id === "m1", boxes: () => boxes } });
    await bed.create();
    expect(bed.fake.children).toHaveLength(1);
  });
});
