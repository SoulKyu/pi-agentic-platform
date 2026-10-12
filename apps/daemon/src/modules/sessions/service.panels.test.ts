import { type Caller } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { testCaller } from "../../testing/caller.ts";

const owner: Caller = testCaller();
const stranger: Caller = testCaller({ userId: "u2" });

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

describe("panel input", () => {
  it("goes to the worker of an open panel, for the owner", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.emit({ type: "custom_render", id: "pn1", lines: ["a"] });
    await bed.clock.advance(0);
    bed.service.panelInput({ sessionId: "p1", panelId: "pn1", data: "\r" }, owner);
    expect(bed.spawned[0]?.sent.at(-1)).toEqual({ type: "custom_input", id: "pn1", data: "\r" });
  });

  it("is not_found for a stranger, an unknown panel, an unknown session and a session without a worker", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.emit({ type: "custom_render", id: "pn1", lines: ["a"] });
    await bed.clock.advance(0);
    const attempt = (sessionId: string, panelId: string, caller: Caller) =>
      codeOf(Promise.resolve().then(() => bed.service.panelInput({ sessionId, panelId, data: "x" }, caller)));
    expect(await attempt("p1", "pn1", stranger)).toBe("not_found");
    expect(await attempt("p1", "other", owner)).toBe("not_found");
    expect(await attempt("nope", "pn1", owner)).toBe("not_found");
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    expect(await attempt("p1", "pn1", owner)).toBe("not_found");
    expect(bed.spawned[0]?.sent.filter((record) => record.type === "custom_input")).toEqual([]);
  });

  it("puts the open panels and recent notices in the snapshot, and nothing for a cold session", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.emit({ type: "custom_render", id: "pn1", lines: ["a"] });
    bed.spawned[0]?.emit({ type: "extension_ui_request", id: "n", method: "notify", message: "hi" });
    bed.spawned[0]?.emit({
      type: "extension_ui_request",
      id: "s",
      method: "setStatus",
      statusKey: "git",
      statusText: "main",
    });
    await bed.clock.advance(0);
    expect(await bed.snapshot("p1")).toMatchObject({
      panels: [{ id: "pn1", lines: ["a"] }],
      notices: [{ level: "info", text: "hi", source: "extension" }],
      statuses: [{ key: "git", text: "main" }],
      hiddenDialogs: 0,
    });
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    expect(await bed.snapshot("p1")).toMatchObject({ panels: [], statuses: [], status: "cold" });
  });
});
