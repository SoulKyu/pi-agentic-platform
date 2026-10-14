import { NO_MARKS } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createMarksStore } from "./marks-store.ts";
import { summaryOf } from "./shell.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());
const crash = async (index: number) => {
  bed.spawned[index]?.crash({ code: 1, signal: null, cause: "exit_code" });
  await bed.clock.advance(0);
};
const listed = (id: string) => bed.service.list(OWNER).find((summary) => summary.id === id);

describe("the stored preset is exposed (MC37)", () => {
  it("is in the session list and the snapshot of a session made with a preset", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "read-only");
    expect(listed(sessionId)?.toolPreset).toBe("read-only");
    expect(await bed.snapshot(sessionId)).toMatchObject({ toolPreset: "read-only" });
  });

  it("is configured for a session without one", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(listed(sessionId)?.toolPreset).toBe("configured");
    expect(await bed.snapshot(sessionId)).toMatchObject({ toolPreset: "configured" });
  });

  it("is in the snapshot of a cold session, and follows a change made while it is cold", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "full");
    await crash(0);
    expect(await bed.snapshot(sessionId)).toMatchObject({
      status: "cold",
      loadout: null,
      toolPreset: "full",
    });
    await bed.service.setTools({ sessionId, preset: "chat" }, OWNER);
    expect(await bed.snapshot(sessionId)).toMatchObject({ status: "cold", toolPreset: "chat" });
    expect(listed(sessionId)?.toolPreset).toBe("chat");
  });

  it("reads a value this version does not know as chat, in the list and the snapshot", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "full");
    await crash(0);
    bed.db.run("PRAGMA ignore_check_constraints = ON");
    bed.db.run("UPDATE sessions SET tool_preset = 'future' WHERE id = $id", { id: sessionId });
    bed.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(listed(sessionId)?.toolPreset).toBe("chat");
    expect(await bed.snapshot(sessionId)).toMatchObject({ toolPreset: "chat" });
    expect(createMarksStore(bed.db).row(sessionId)?.toolPreset).toBe("chat");
  });

  it("reads the stored preset of a shell row, configured when none", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "none");
    const other = await bed.service.create(bed.work, OWNER);
    const marks = createMarksStore(bed.db);
    expect(marks.row(sessionId)?.toolPreset).toBe("none");
    expect(marks.row(other.sessionId)?.toolPreset).toBe("configured");
  });

  it("is in the shell summary", () => {
    bed = build();
    const row = {
      id: "s1",
      ownerId: "u1",
      cwd: "/w",
      name: null,
      preview: null,
      projectId: null,
      createdAt: 1,
      updatedAt: 2,
      toolPreset: "none" as const,
      marks: NO_MARKS,
    };
    expect(summaryOf(row, { status: "cold", needsInput: false }).toolPreset).toBe("none");
  });
});
