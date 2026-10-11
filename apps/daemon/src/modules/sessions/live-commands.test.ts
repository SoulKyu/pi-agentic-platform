import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createFakeWorker } from "../../kernel/testing/fake-worker.ts";
import { createLiveCommands, refusalOf } from "./live-commands.ts";
import { silentLogger } from "../../kernel/logger.ts";

const setup = (reply?: (type: string) => object | undefined) => {
  const worker = createFakeWorker({
    clock: createFakeClock(),
    reply: (command) => reply?.(command.type),
  });
  return { worker, commands: createLiveCommands({ handle: worker, logger: silentLogger }) };
};
const idOf = (worker: { requests: Array<{ type: string; id: string }> }, type: string) =>
  worker.requests.find((request) => request.type === type)?.id ?? "";

describe("refusalOf", () => {
  it.each([
    ["compact", "Nothing to compact (session too small)", "session_empty"],
    ["compact", "NOTHING TO COMPACT", "session_empty"],
    ["compact", "nothing to compact", "session_empty"],
    ["compact", "No API key found for x.", "command_failed"],
    ["compact", "", "command_failed"],
    ["navigate_tree", "Nothing to compact", "command_failed"],
    ["navigate_tree", "Entry e9 not found", "command_failed"],
    ["set_session_name", "Nothing to compact", "command_failed"],
  ] as const)("maps %s refusing with %j to %s", (command, error, code) => {
    expect(refusalOf(command, error)).toBe(code);
  });
});

describe("command", () => {
  it("counts a request from its synchronous send to its answer, structural ones apart", async () => {
    const { worker, commands } = setup(() => undefined);
    const navigating = commands.command({ type: "navigate_tree", targetId: "e1" });
    // Nothing was awaited: the request is already counted and already sent.
    expect(worker.requests.map((request) => request.type)).toEqual(["navigate_tree"]);
    expect([commands.inFlight(), commands.structuralInFlight(), commands.compactInFlight()]).toEqual([
      1, 1, 0,
    ]);
    const compacting = commands.command({ type: "compact" });
    const naming = commands.command({ type: "set_session_name", name: "n" });
    expect([commands.inFlight(), commands.structuralInFlight(), commands.compactInFlight()]).toEqual([
      3, 2, 1,
    ]);
    worker.respond(idOf(worker, "navigate_tree"), { data: { cancelled: false } });
    expect(await navigating).toEqual({ ok: true, data: { cancelled: false } });
    worker.respond(idOf(worker, "compact"), { success: false, error: "No API key" });
    expect(await compacting).toEqual({ ok: false, error: "No API key" });
    worker.respond(idOf(worker, "set_session_name"), {});
    await naming;
    expect([commands.inFlight(), commands.structuralInFlight(), commands.compactInFlight()]).toEqual([
      0, 0, 0,
    ]);
  });

  it("stops counting when the worker dies, and the failure reaches the caller", async () => {
    const { worker, commands } = setup(() => undefined);
    const compacting = commands.command({ type: "compact" });
    worker.crash({ code: 1, signal: null, cause: "exit_code" });
    await expect(compacting).rejects.toThrow(new PapError("worker_failed"));
    expect([commands.inFlight(), commands.structuralInFlight(), commands.compactInFlight()]).toEqual([
      0, 0, 0,
    ]);
  });

  it("says a missing error text as an empty string, never undefined", async () => {
    const { commands } = setup(() => ({ success: false }));
    expect(await commands.command({ type: "compact" })).toEqual({ ok: false, error: "" });
  });
});

describe("activity", () => {
  const event = (fields: { type: string } & Record<string, unknown>) => fields;

  it("follows compaction and the automatic retry, and says only what changed", () => {
    const { commands } = setup();
    expect(commands.activity()).toEqual({ compacting: false, retry: null });
    expect(commands.onPiEvent(event({ type: "compaction_start", reason: "manual" }))).toEqual({
      kind: "activity",
      activity: { compacting: true, retry: null },
    });
    expect(commands.onPiEvent(event({ type: "compaction_start", reason: "manual" }))).toBeNull();
    expect(commands.onPiEvent(event({ type: "compaction_end", aborted: false }))).toEqual({
      kind: "activity",
      activity: { compacting: false, retry: null },
    });
    expect(commands.onPiEvent(event({ type: "auto_retry_start", attempt: 2, maxAttempts: 3 }))).toEqual({
      kind: "activity",
      activity: { compacting: false, retry: { attempt: 2, maxAttempts: 3 } },
    });
    expect(commands.onPiEvent(event({ type: "agent_start" }))).toEqual({
      kind: "activity",
      activity: { compacting: false, retry: null },
    });
    expect(commands.onPiEvent(event({ type: "agent_start" }))).toBeNull();
    expect(commands.onPiEvent(event({ type: "message_end" }))).toBeNull();
  });

  it("ends a retry on auto_retry_end", () => {
    const { commands } = setup();
    commands.onPiEvent(event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 }));
    expect(commands.onPiEvent(event({ type: "auto_retry_end", success: true, attempt: 1 }))).toEqual({
      kind: "activity",
      activity: { compacting: false, retry: null },
    });
  });

  it("takes only whole, non-negative counts from the worker; anything else is no retry", () => {
    const { commands } = setup();
    for (const bad of [
      { attempt: -1, maxAttempts: 3 },
      { attempt: 1.5, maxAttempts: 3 },
      { attempt: "2", maxAttempts: 3 },
      { attempt: 1 },
      { attempt: Number.NaN, maxAttempts: 3 },
    ]) {
      expect(commands.onPiEvent(event({ type: "auto_retry_start", ...bad }))).toBeNull();
    }
    expect(commands.activity()).toEqual({ compacting: false, retry: null });
  });

  it("is idle again after reset", () => {
    const { commands } = setup();
    commands.onPiEvent(event({ type: "compaction_start" }));
    commands.reset();
    expect(commands.activity()).toEqual({ compacting: false, retry: null });
  });
});
