import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createSessionsLanePort, type LaneProbe } from "./lane-port.ts";
import type { LiveSession } from "./live-session.ts";
import type { SessionsService } from "./service-types.ts";

const caller = testCaller();

function bed(answer: { ok: true; data: unknown } | { ok: false; error: string }, started = true) {
  const live = new Map<string, LiveSession>();
  const command = vi.fn<(input: unknown) => Promise<typeof answer>>(async () => answer);
  const reopen = vi.fn<SessionsService["reopen"]>(async (sessionId) => {
    if (started) live.set(sessionId, { command } as unknown as LiveSession);
  });
  const { logger, lines } = captureLogger();
  const port = createSessionsLanePort({
    service: { reopen } as never,
    store: { listByOwner: () => [], get: () => undefined },
    marks: { row: () => undefined },
    probe: { live } as unknown as LaneProbe,
    waiting: () => false,
    logger,
  });
  return { port, command, reopen, lines };
}

describe("SessionsLanePort.suggestCommit (M9R80)", () => {
  it("brings the worker up for a cold session, then sends the diff to it", async () => {
    const t = bed({ ok: true, data: { message: "fix: a" } });
    expect(await t.port.suggestCommit(caller, "s1", "DIFF")).toEqual({ ok: true, message: "fix: a" });
    expect(t.reopen).toHaveBeenCalledWith("s1", caller);
    expect(t.command).toHaveBeenCalledWith({ type: "suggest_commit", diff: "DIFF" });
  });

  it("strips hidden characters and controls, keeps newlines and tabs, and clips to 2 000", async () => {
    const dirty = "fix:\u202E a\u200B\u0007\u0085b\r\n\n\tbody\u2028x" + "z".repeat(3000);
    const t = bed({ ok: true, data: { message: dirty } });
    const answer = await t.port.suggestCommit(caller, "s1", "DIFF");
    expect(answer.ok).toBe(true);
    const message = (answer as { message: string }).message;
    expect(message.startsWith("fix: ab\n\n\tbody\nx")).toBe(true);
    for (const hidden of ["\u202E", "\u200B", "\u0007", "\u0085", "\r", "\u2028"])
      expect(message).not.toContain(hidden);
    expect(message.length).toBeLessThanOrEqual(2000);
  });

  it.each([[{ message: "\u200B\u0007  " }], [{ message: 5 }], [null]])(
    "answers model_failed for the unusable data %j",
    async (data) => {
      const t = bed({ ok: true, data });
      expect(await t.port.suggestCommit(caller, "s1", "DIFF")).toEqual({ ok: false, reason: "model_failed" });
    },
  );

  it("answers model_failed for a refused command and logs the worker's text clipped, never returning it", async () => {
    const t = bed({ ok: false, error: `secret ${"e".repeat(5000)}` });
    expect(await t.port.suggestCommit(caller, "s1", "DIFF")).toEqual({ ok: false, reason: "model_failed" });
    const line = JSON.stringify(t.lines);
    expect(line).toContain("lane_suggest_refused");
    expect(line.length).toBeLessThan(4000);
  });

  it("throws worker_failed when no worker came up", async () => {
    const t = bed({ ok: true, data: { message: "x" } }, false);
    await expect(t.port.suggestCommit(caller, "s1", "DIFF")).rejects.toEqual(new PapError("worker_failed"));
  });
});
