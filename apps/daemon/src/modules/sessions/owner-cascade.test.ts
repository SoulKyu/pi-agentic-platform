import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskSessionPolicy } from "./automation-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { noAttachments } from "./testing/no-attachments.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const POLICY: TaskSessionPolicy = { mode: "supervised", tools: ["read"], preset: "read-only", tainted: true };

async function session(ownerId: string, index: number, keep: boolean) {
  const { sessionId } = await bed.service.automation.createTaskSession({
    ownerId,
    cwd: bed.work,
    policy: POLICY,
  });
  const file = bed.writePiFile(index);
  bed.store.bindPiFile(sessionId, file, `pi-${index}`);
  if (!keep) bed.service.automation.releaseIdle(ownerId, sessionId);
  return { sessionId, file };
}

describe("sessions ownerCascade (A5b)", () => {
  it("removes the live and idle sessions of the owner, their Pi files, attachments and pending exports; another owner's stay", async () => {
    const dropOwner = vi.fn();
    bed = build({ attachments: { ...noAttachments, dropOwner } });
    const idle = await session("m1", 0, false);
    const live = await session("m1", 1, true);
    const other = await session("u1", 2, true);
    const pending = bed.exports.prepare(other.sessionId, "u1");
    const mine = bed.exports.prepare(live.sessionId, "m1");
    writeFileSync(mine.path, "<html></html>");

    expect(await bed.service.ownerCascade.removeAll("m1")).toEqual({ sessions: 2 });

    expect(bed.store.get(idle.sessionId)).toBeUndefined();
    expect(bed.store.get(live.sessionId)).toBeUndefined();
    expect(bed.store.get(other.sessionId)).toBeDefined();
    expect(existsSync(idle.file)).toBe(false);
    expect(existsSync(live.file)).toBe(false);
    expect(existsSync(other.file)).toBe(true);
    expect(dropOwner).toHaveBeenCalledWith("m1", expect.arrayContaining([idle.sessionId, live.sessionId]));
    expect(bed.exports.take(mine.token, live.sessionId, "m1")).toBeNull();
    expect(existsSync(mine.path)).toBe(false);
    expect(bed.exports.take(pending.token, other.sessionId, "u1")).not.toBeNull();
    expect(await bed.service.ownerCascade.removeAll("m1")).toEqual({ sessions: 0 });
  });
});
