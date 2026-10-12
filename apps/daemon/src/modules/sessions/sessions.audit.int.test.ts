import { expect, it, vi } from "vitest";
import { createIntBed } from "./testing/int-bed.ts";

// The real pi-host sends its stage-00 `session` entry when the worker starts; the daemon stores it in the audit table
// and nothing about it in the session journal.
it("stores a started worker's session entry in the audit table, not in session_events", async () => {
  const bed = await createIntBed({ steps: [{ text: "unused" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    await vi.waitFor(
      () => expect(bed.auditRows()).toEqual([{ kind: "session", actor: "worker", sessionId }]),
      { timeout: 10_000 },
    );
    expect(bed.sessionEvents()).toEqual([]);
    const listed = await bed.auditRpc["audit.list"]({}, bed.ctx);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({ kind: "session", sessionId, actor: "worker" });
    expect(listed.entries[0]?.stages.some((verdict) => verdict.stage === "05")).toBe(true);
    expect(listed.entries[0]?.stages.find((verdict) => verdict.stage === "05")?.reason).toMatch(
      /; worker scope off$/,
    );
  } finally {
    await bed.dispose();
  }
});
