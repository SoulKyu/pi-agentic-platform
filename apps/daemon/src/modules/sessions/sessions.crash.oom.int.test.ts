import { afterEach, describe, expect, it } from "vitest";
import { hog, hogCommand } from "./testing/extensions.ts";
import { createIntBed, type IntBed } from "./testing/int-bed.ts";
import { realScopes, releaseScopes, scopesAvailable } from "./testing/real-scopes.ts";

const LIMITS = { memoryMaxMb: 256, tasksMax: 512, memorySwapMaxMb: 0 };
// The hog stops itself at twice the limit, so a missing limit fails the test instead of eating the host.
const CEILING_MB = LIMITS.memoryMaxMb * 2;

const beds: IntBed[] = [];
afterEach(async () => {
  try {
    for (const bed of beds.splice(0)) await bed.dispose();
  } finally {
    expect(await releaseScopes()).toEqual([]);
  }
});

describe.skipIf(!scopesAvailable)("a worker's memory limit (M2R114)", () => {
  it("keeps the session when the scope's limit kills a command the agent ran (owner R2-1)", async () => {
    const scopes = await realScopes(LIMITS);
    const call = { toolCalls: [{ name: "bash", args: { command: hogCommand(CEILING_MB) }, id: "c1" }] };
    const bed = await createIntBed({ steps: [call, { text: "the command was killed" }] }, { scopes });
    beds.push(bed);
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "run it" }, bed.ctx);
    const card = await sub.waitFor((e) => e.kind === "dialog_open");
    if (card.kind !== "dialog_open") throw new Error("no card");
    await bed.rpc["sessions.respondDialog"](
      { sessionId, dialogId: card.dialog.id, response: { answer: "once" } },
      bed.ctx,
    );
    const settled = await sub.waitFor(
      (e) => e.kind === "status" && (e.status === "idle" || e.status === "cold"),
      30_000,
    );
    expect(settled).toEqual({ kind: "status", status: "idle" });
    expect(bed.exits).toEqual([]);
  });

  it("says out of memory when the worker's scope limit kills it", async () => {
    const scopes = await realScopes(LIMITS);
    const bed = await createIntBed(
      { steps: [{ text: "unused" }] },
      { extensions: { hog: hog(CEILING_MB) }, scopes },
    );
    beds.push(bed);
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "/hog" }, bed.ctx).catch(() => undefined);
    expect(await sub.waitFor((e) => e.kind === "status" && e.status === "cold", 30_000)).toEqual({
      kind: "status",
      status: "cold",
      cause: "Agent process ran out of memory and was stopped.",
      causeCode: "process_oom",
    });
    expect(bed.exits.map((exit) => exit.exit.cause)).toEqual(["oom"]);
  });
});
