import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createIntBed, promptAndSettle } from "./testing/int-bed.ts";

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../budgets.json", import.meta.url)), "utf8"),
) as { sessionOpenPayloadKb: number; idleWorkerRssMb: number };

// Idle RSS: docs/spikes/s4-m2-long-session.md measured 169-173 MB with the worker flags (10 workers, p95 173) and set
// the budget at ceil(173 x 1.1) = 191.
// The reading is the worker's own VmRSS from its first `health` record, taken once and read by this process:
// it does not depend on the load of the host, the order of the tests or how many other workers run, only on the
// worker's own heap, so the 10 % margin is spent on build and Node differences, not on noise. Nothing here sleeps:
// `vi.waitFor` ends on the first health record, with a deadline.
it("keeps an idle worker under its RSS budget", async () => {
  const bed = await createIntBed({ steps: [{ text: "unused" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    await vi.waitFor(() => expect(bed.sessions.inspect(sessionId)?.rssMb).not.toBeNull(), {
      timeout: 10_000,
    });
    const rssMb = bed.sessions.inspect(sessionId)?.rssMb ?? Number.POSITIVE_INFINITY;
    // A reading of 0 would pass the cap without measuring a Node process: S4 never saw less than 153 MB.
    expect(rssMb).toBeGreaterThan(50);
    console.log(`idle worker RSS: ${rssMb} MB (budget ${budgets.idleWorkerRssMb})`);
    expect(rssMb).toBeLessThanOrEqual(budgets.idleWorkerRssMb);
  } finally {
    await bed.dispose();
  }
});

// The beds fork workers the way the daemon does, so the measurements match production (R45): the worker's command
// line, as the kernel holds it, carries the semi-space flag that keeps its RSS near the live heap.
it("forks its workers with the semi-space flag the budget was measured with", async () => {
  const bed = await createIntBed({ steps: [{ text: "unused" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const pid = bed.sessions.inspect(sessionId)?.pid;
    if (pid === undefined || pid <= 1) throw new Error("no worker pid");
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    expect(argv.filter((arg) => arg.includes("semi-space"))).toEqual(["--max-semi-space-size=16"]);
  } finally {
    await bed.dispose();
  }
});

// A cap, so `toBeLessThanOrEqual(budget)` is the exact assertion: the budget is the value under test.
it("opens a ten-exchange session in a snapshot under the payload budget", async () => {
  const reply = "a reply of a usual length, ".repeat(8);
  const bed = await createIntBed({ steps: Array.from({ length: 10 }, () => ({ text: reply })) });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    for (let i = 0; i < 10; i++) {
      await promptAndSettle(bed, sub, sessionId, `question ${i}: ${"q".repeat(150)}`);
    }
    const opened = await bed.subscribe(sessionId);
    const first = opened.events()[0];
    expect(first?.kind).toBe("snapshot");
    const bytes = Buffer.byteLength(JSON.stringify(first));
    console.log(`session open payload: ${bytes} bytes (budget ${budgets.sessionOpenPayloadKb * 1024})`);
    expect(bytes).toBeLessThanOrEqual(budgets.sessionOpenPayloadKb * 1024);
  } finally {
    await bed.dispose();
  }
});
