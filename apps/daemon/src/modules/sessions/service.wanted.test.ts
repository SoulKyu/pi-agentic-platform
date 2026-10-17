import { type Caller } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const owner: Caller = testCaller();
let bed: ReturnType<typeof build>;
const build = () => createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader });
afterEach(() => bed.dispose());

const prompts = (index: number) =>
  bed.spawned[index]?.requests.filter((request) => request.type === "prompt").length;

describe("a prompt nobody wants any more (N1)", () => {
  it("is never sent to a cold session whose reopen finished after the task was cancelled", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    let wanted = true;
    const pending = bed.service.prompt({ sessionId: "p1", text: "x", stillWanted: () => wanted }, owner);
    // The task is cancelled while the worker is coming back.
    wanted = false;
    expect(await pending).toEqual({ disposition: "handled" });
    expect(bed.spawned).toHaveLength(2);
    expect(prompts(1)).toBe(0);
  });

  it("is never sent to a warm session either", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    expect(await bed.service.prompt({ sessionId: "p1", text: "x", stillWanted: () => false }, owner)).toEqual(
      {
        disposition: "handled",
      },
    );
    expect(prompts(0)).toBe(0);
  });

  it("is sent when it is still wanted at the last moment", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    let asked = 0;
    const result = await bed.service.prompt(
      { sessionId: "p1", text: "x", stillWanted: () => (asked += 1) > 0 },
      owner,
    );
    expect(result).toEqual({ disposition: "started" });
    expect(asked).toBe(1);
    expect(prompts(0)).toBe(1);
  });
});
