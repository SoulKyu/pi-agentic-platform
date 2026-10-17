import type { PlatformResultRecord } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformPort } from "../platform/index.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { captureLogger } from "./testing/helpers.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

let bed: ReturnType<typeof open>;
afterEach(() => bed.dispose());

function open(logger = captureLogger()) {
  const made = createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    { logger: logger.logger },
  );
  return Object.assign(made, { lines: logger.lines });
}

const portOf = (onRecord: PlatformPort["onRecord"]): PlatformPort => ({
  workerEnded: () => {},
  register: () => {},
  available: () => false,
  onRecord,
  stop: () => {},
});
const CALL = {
  type: "platform_call" as const,
  id: "p1",
  op: "lane.note" as const,
  toolCallId: "tc1",
  args: { note: "x" },
};

describe("the platform bridge", () => {
  it("hands a platform_call to the port with the session's row, and the reply goes to the worker", async () => {
    bed = open();
    const seen: unknown[] = [];
    const answer: PlatformResultRecord = { type: "platform_result", id: "p1", ok: true, result: {} };
    bed.service.agent.setAgentPorts({
      platform: portOf((row, record, reply) => {
        seen.push([row.id, row.ownerId, record]);
        reply(answer);
      }),
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit(CALL);
    expect(seen).toEqual([[sessionId, OWNER.userId, CALL]]);
    expect(bed.spawned[0]?.sent.filter((record) => record.type === "platform_result")).toEqual([answer]);
  });

  it("hands a platform_cancel to the port and nothing else", async () => {
    bed = open();
    const record = vi.fn();
    bed.service.agent.setAgentPorts({ platform: portOf(record) });
    await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit({ type: "platform_cancel", id: "p1" });
    bed.spawned[0]?.emit({ type: "audit", entry: { kind: "x" } });
    bed.spawned[0]?.emit({ type: "pi_event", event: { type: "agent_start" } });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[1]).toEqual({ type: "platform_cancel", id: "p1" });
  });

  it("logs a port that throws and keeps the session running", async () => {
    bed = open();
    bed.service.agent.setAgentPorts({
      platform: portOf(() => {
        throw new Error("secret-token-ghp_zzz");
      }),
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit(CALL);
    const line = bed.lines.find((entry) => entry.msg === "platform_bridge_failed");
    expect(line).toMatchObject({ sessionId, errorClass: "Error" });
    expect(JSON.stringify(bed.lines)).not.toContain("secret-token");
    expect(bed.spawned[0]?.stopped()).toBe(false);
    expect(await bed.service.prompt({ sessionId, text: "hello" }, OWNER)).toEqual({ disposition: "started" });
  });

  it("ignores the calls of a daemon with no platform port", async () => {
    bed = open();
    await bed.service.create(bed.work, OWNER);
    expect(() => bed.spawned[0]?.emit(CALL)).not.toThrow();
    expect(bed.spawned[0]?.sent.some((record) => record.type === "platform_result")).toBe(false);
  });

  it("reads the port at the call, so one set after the worker started is used", async () => {
    bed = open();
    await bed.service.create(bed.work, OWNER);
    const record = vi.fn();
    bed.service.agent.setAgentPorts({ platform: portOf(record) });
    bed.spawned[0]?.emit(CALL);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("tells the port when the worker has gone, with the same reply", async () => {
    bed = open();
    const ended = vi.fn();
    const record = vi.fn();
    const platform = { ...portOf(record), workerEnded: ended };
    bed.service.agent.setAgentPorts({ platform });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit(CALL);
    await bed.spawned[0]?.stop();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(ended.mock.calls[0]?.[1]).toBe(record.mock.calls[0]?.[2]);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({ id: sessionId, ownerId: OWNER.userId });
  });
});
