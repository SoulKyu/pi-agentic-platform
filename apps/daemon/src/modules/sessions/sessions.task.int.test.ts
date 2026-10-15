import { expect, it, vi } from "vitest";
import { createIntBed, promptAndSettle } from "./testing/int-bed.ts";

const TASK = { mode: "supervised", tools: ["read", "grep"], preset: "read-only", tainted: true } as const;

it("a task session released after its run keeps its list, mode, taint and unattended flag; a clone keeps the list and is attended", async () => {
  const bed = await createIntBed({ steps: [{ text: "r0" }, { text: "r1" }] });
  try {
    const { automation } = bed.sessions;
    const { sessionId } = await automation.createTaskSession({ ownerId: "u1", cwd: bed.work, policy: TASK });
    const stored = () => bed.policy.port.sessionPolicy("u1", sessionId);
    const expected = {
      mode: "supervised",
      explicit: true,
      taint: { tainted: true, epoch: 0 },
      toolAllowlist: ["read", "grep"],
      unattended: true,
    };
    expect(stored()).toMatchObject(expected);

    const live = await bed.subscribe(sessionId);
    await promptAndSettle(bed, live, sessionId, "q0");
    // Pi writes the file a moment after the run settles; a release before that would leave nothing to reopen.
    await vi.waitFor(
      async () => {
        const first = (await bed.subscribe(sessionId)).events()[0];
        if (first?.kind !== "snapshot" || first.rows.length !== 2) throw new Error("no file yet");
      },
      { timeout: 20_000 },
    );
    expect(automation.releaseIdle("u1", sessionId)).toBe("released");
    await live.waitFor((event) => event.kind === "status" && event.status === "cold");
    expect(automation.state("u1", sessionId)).toMatchObject({ running: false });

    // Reopened by the runner's next prompt: the worker starts from the stored rules.
    const reopened = await bed.subscribe(sessionId);
    expect(await automation.prompt({ ownerId: "u1", sessionId, text: "q1" })).toBe("started");
    await reopened.waitFor((event) => event.kind === "status" && event.status === "idle");
    expect(stored()).toMatchObject(expected);

    const cloned = await bed.rpc["sessions.clone"]({ sessionId }, bed.ctx);
    expect(bed.policy.port.sessionPolicy("u1", cloned.sessionId)).toMatchObject({
      mode: "supervised",
      toolAllowlist: ["read", "grep"],
      unattended: false,
      taint: { tainted: true },
    });
  } finally {
    await bed.dispose();
  }
}, 60_000);
