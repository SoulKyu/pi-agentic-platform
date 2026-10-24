import { describe, expect, it } from "vitest";
import { CRASH_LIMIT } from "./lifecycle.ts";
import { projectLayoutOf } from "./project-layout.ts";
import { bed, PROJECT_ID, settle, specOf, workerInput } from "./runtime-fixtures.ts";

const PROJECT = { kind: "project", id: PROJECT_ID } as const;

describe("the crash pause of a project box (RT-40)", () => {
  it("three crashes in ten minutes tell the pause once, and later launches answer agent_paused", async () => {
    const b = bed({ layout: () => projectLayoutOf("process", "/pap", PROJECT_ID) });
    await b.runtime.stopAll();
    const spec = specOf("unused", { box: PROJECT });
    for (let i = 0; i < CRASH_LIMIT; i++) {
      await b.runtime.spawn(spec, workerInput(), null);
      b.guestAt(-1).crash();
      await settle();
    }
    expect(b.crashPauses).toEqual([`project:${PROJECT_ID}`]);
    await expect(b.runtime.spawn(spec, workerInput(), null)).rejects.toMatchObject({ code: "agent_paused" });
    expect(b.crashPauses).toHaveLength(1);
    b.runtime.resume(PROJECT);
    await b.runtime.spawn(spec, workerInput(), null);
    expect(b.runtime.phase(PROJECT)).toBe("running");
  });
});
