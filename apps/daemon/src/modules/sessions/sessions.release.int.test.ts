import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { shutdownProbe, slowShutdownProbe } from "./testing/extensions.ts";
import { createIntBed, promptAndSettle } from "./testing/int-bed.ts";

it("releases an idle worker, tells its extensions, and the next prompt reopens the same file", async () => {
  const probe = join(tmpdir(), `pap-release-${process.pid}-${Date.now()}.txt`);
  const bed = await createIntBed(
    { steps: [{ text: "first" }, { text: "unused" }] },
    { workerIdleMs: 1500, extensions: { probe: shutdownProbe(probe) } },
  );
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "hello");
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold", 10_000);
    const statuses = sub.events().flatMap((event) => (event.kind === "status" ? [event] : []));
    expect(statuses.slice(-2)).toEqual([
      { kind: "status", status: "releasing" },
      { kind: "status", status: "cold" },
    ]);
    expect(readFileSync(probe, "utf8")).toBe("quit\n");
    const listed = (await bed.rpc["sessions.list"]({}, bed.ctx)).sessions[0];
    expect(listed?.status).toBe("cold");
    expect(bed.exits.map((exit) => exit.exit.cause)).toEqual(["clean"]);
    await promptAndSettle(bed, sub, sessionId, "again");
    const after = await bed.subscribe(sessionId);
    const snapshot = after.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    expect(snapshot.rows.map((row) => (row.message as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  } finally {
    rmSync(probe, { force: true });
    await bed.dispose();
  }
});

it("a prompt sent while the worker is being released waits for the exit and is answered by the next worker", async () => {
  // The extension holds the closing worker for a second: the prompt is sent while it is still there, not after it.
  const probe = join(tmpdir(), `pap-release-slow-${process.pid}-${Date.now()}.txt`);
  const bed = await createIntBed(
    { steps: [{ text: "first" }, { text: "second" }] },
    { workerIdleMs: 1500, extensions: { probe: slowShutdownProbe(probe, 1000) } },
  );
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await promptAndSettle(bed, sub, sessionId, "hello");
    await sub.waitFor((event) => event.kind === "status" && event.status === "releasing", 10_000);
    const statusesNow = () =>
      sub.events().flatMap((event) => (event.kind === "status" ? [event.status] : []));
    expect(statusesNow().at(-1)).toBe("releasing");
    expect(bed.exits).toEqual([]);
    await promptAndSettle(bed, sub, sessionId, "during");
    const statuses = statusesNow();
    const from = statuses.indexOf("releasing");
    expect(statuses.slice(from, from + 3)).toEqual(["releasing", "cold", "starting"]);
    expect(readFileSync(probe, "utf8")).toBe("quit\n");
    expect(bed.exits.map((exit) => exit.exit.cause)).toEqual(["clean"]);
  } finally {
    rmSync(probe, { force: true });
    await bed.dispose();
  }
});
