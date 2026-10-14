import { ERROR_MESSAGES, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { captureLogger, codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { testCaller } from "../../testing/caller.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options: BedOptions = {}) => {
  bed = build(options);
};
afterEach(() => bed.dispose());

const listed = {
  commands: [
    { name: "review", description: "Review the diff", source: "prompt", builtinMcp: false },
    { name: "mcp", description: null, source: "extension", builtinMcp: true },
  ],
  truncated: false,
};

describe("sessions.commands (slash menu)", () => {
  it("asks the live worker and answers its list", async () => {
    open({ replies: { get_commands: { data: listed } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.commands(sessionId, OWNER)).toEqual(listed);
    expect(bed.spawned[0]?.requests.at(-1)).toMatchObject({ type: "get_commands" });
  });

  it("starts the worker of a cold session for it, like sessions.models", async () => {
    open({ replies: { get_commands: { data: listed } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    expect(bed.service.list(OWNER)[0]?.status).toBe("cold");
    expect(await bed.service.commands(sessionId, OWNER)).toEqual(listed);
    expect(bed.spawned).toHaveLength(2);
    expect(bed.spawned[1]?.requests.map((request) => request.type)).toEqual(["get_commands"]);
  });

  it("is capacity-limited like any worker start", async () => {
    open({ limits: { maxWorkers: 1, minFreeMemMb: 0 }, replies: { get_commands: { data: listed } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    await bed.service.create(bed.otherWork, OWNER);
    expect(await codeOf(bed.service.commands(sessionId, OWNER))).toBe("capacity");
  });

  it("is not_found for another owner's session", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await codeOf(bed.service.commands(sessionId, testCaller({ userId: "someone-else" })))).toBe(
      "not_found",
    );
    expect(await codeOf(bed.service.commands("ghost", OWNER))).toBe("not_found");
  });

  it("refuses an answer it cannot read as command_failed, without the worker's text", async () => {
    const logs = captureLogger();
    open({
      logger: logs.logger,
      replies: { get_commands: { data: { commands: "<script>alert(1)</script>" } } },
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const error = await bed.service.commands(sessionId, OWNER).catch((caught: unknown) => caught);
    expect(error).toEqual(new PapError("command_failed"));
    expect((error as PapError).message).toBe(ERROR_MESSAGES.command_failed);
    expect(JSON.stringify(logs)).not.toContain("script");
  });

  it("refuses a worker refusal as command_failed", async () => {
    open({ replies: { get_commands: { success: false, error: "/home/u/.pi/agent/auth.json: EACCES" } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const error = await bed.service.commands(sessionId, OWNER).catch((caught: unknown) => caught);
    expect(error).toEqual(new PapError("command_failed"));
  });
});
